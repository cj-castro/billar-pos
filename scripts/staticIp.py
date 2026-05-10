#!/usr/bin/env python3
"""
set_static_ip.py - Set or validate a static IP address on Windows via netsh (Admin required).
"""

import subprocess
import sys
import ctypes
import argparse
import re

# ----------------------------------------------------------------------
# Admin elevation
# ----------------------------------------------------------------------
def is_admin():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except AttributeError:
        return False

def run_as_admin():
    import subprocess as sp
    cmd_line = sp.list2cmdline(sys.argv)
    ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, cmd_line, None, 1)
    sys.exit(0)

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def list_network_interfaces():
    result = subprocess.run(["netsh", "interface", "ip", "show", "interfaces"], capture_output=True, text=True)
    print("\n=== Available Network Interfaces ===\n")
    print(result.stdout)
    print("Note: Use the exact 'Interface Name' from the list above (in quotes if it contains spaces).\n")

def is_valid_ip(ip):
    pattern = re.compile(
        r"^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\."
        r"(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\."
        r"(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\."
        r"(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$"
    )
    return bool(pattern.match(ip))

def run_netsh(command, capture_error=True):
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, check=False)
        success = (result.returncode == 0)
        if not success and capture_error:
            print(f"Command failed: {command}\nError: {result.stderr.strip()}")
        return success, result.stdout.strip(), result.stderr.strip()
    except Exception as e:
        print(f"Exception: {e}")
        return False, "", str(e)

def get_current_interface_config(interface):
    """Retrieve current IP, subnet, gateway, and DNS servers for an interface."""
    # Get IP and subnet
    cmd = f'netsh interface ip show config name="{interface}"'
    success, out, err = run_netsh(cmd, capture_error=False)
    if not success:
        return None

    config = {"ip": None, "subnet": None, "gateway": None, "dns": []}
    lines = out.splitlines()
    for line in lines:
        line = line.strip()
        if "IP Address:" in line or "IP Address" in line:
            # Format: "IP Address: 192.168.1.100(Preferred)"
            parts = line.split(":")
            if len(parts) >= 2:
                ip_part = parts[1].strip()
                ip = ip_part.split()[0]
                config["ip"] = ip
        elif "Subnet Prefix:" in line or "Subnet Mask:" in line:
            parts = line.split(":")
            if len(parts) >= 2:
                config["subnet"] = parts[1].strip().split()[0]
        elif "Default Gateway:" in line:
            parts = line.split(":")
            if len(parts) >= 2:
                gw_part = parts[1].strip()
                if gw_part and gw_part != "None":
                    config["gateway"] = gw_part.split()[0]
        elif "DNS Servers:" in line:
            # Subsequent lines may have DNS entries
            pass
        elif line and ":" not in line and config["dns"] is not None:
            # Some lines after DNS Servers: contain IPs
            if re.match(r"\d+\.\d+\.\d+\.\d+", line):
                config["dns"].append(line)
    # Fallback: use more direct netsh commands for DNS
    dns_cmd = f'netsh interface ip show dns name="{interface}"'
    success2, out2, err2 = run_netsh(dns_cmd, capture_error=False)
    if success2:
        for line in out2.splitlines():
            if "DNS Servers" in line:
                parts = line.split(":")
                if len(parts) >= 2:
                    dns_ip = parts[1].strip()
                    if dns_ip and dns_ip != "None":
                        config["dns"].append(dns_ip)
    # Remove duplicates
    config["dns"] = list(dict.fromkeys(config["dns"]))
    return config

# ----------------------------------------------------------------------
# Set static IP
# ----------------------------------------------------------------------
def set_static_ip(interface, ip, subnet, gateway, dns1, dns2=None):
    if not all([is_valid_ip(ip), is_valid_ip(gateway), is_valid_ip(dns1)]):
        print("❌ Invalid IP address format.")
        return False
    if dns2 and not is_valid_ip(dns2):
        print("❌ Invalid secondary DNS format.")
        return False
    if not is_valid_ip(subnet):
        print("❌ Invalid subnet mask format.")
        return False

    print(f"\n🔧 Configuring interface '{interface}'...")
    run_netsh(f'netsh interface ip set dns "{interface}" dhcp')
    success, _, _ = run_netsh(f'netsh interface ip set address "{interface}" static {ip} {subnet} {gateway}')
    if not success:
        return False
    success, _, _ = run_netsh(f'netsh interface ip set dns "{interface}" static {dns1}')
    if not success:
        return False
    if dns2:
        run_netsh(f'netsh interface ip add dns "{interface}" {dns2} index=2')
    print("✅ Static IP configuration applied.")
    return True

# ----------------------------------------------------------------------
# Validate configuration
# ----------------------------------------------------------------------
def validate_static_ip(interface, expected_ip=None, expected_subnet=None, expected_gateway=None, expected_dns1=None, expected_dns2=None):
    print(f"\n🔍 Validating interface '{interface}'...")
    current = get_current_interface_config(interface)
    if current is None:
        print(f"❌ Could not retrieve configuration for interface '{interface}'. Make sure the name is correct.")
        return False

    print(f"Current: IP={current['ip']}, Subnet={current['subnet']}, Gateway={current['gateway']}, DNS={current['dns']}")

    all_match = True
    if expected_ip and current['ip'] != expected_ip:
        print(f"❌ IP mismatch: expected {expected_ip}, got {current['ip']}")
        all_match = False
    elif expected_ip:
        print(f"✅ IP matches: {current['ip']}")

    if expected_subnet and current['subnet'] != expected_subnet:
        print(f"❌ Subnet mask mismatch: expected {expected_subnet}, got {current['subnet']}")
        all_match = False
    elif expected_subnet:
        print(f"✅ Subnet mask matches: {current['subnet']}")

    if expected_gateway and current['gateway'] != expected_gateway:
        print(f"❌ Gateway mismatch: expected {expected_gateway}, got {current['gateway']}")
        all_match = False
    elif expected_gateway:
        print(f"✅ Gateway matches: {current['gateway']}")

    if expected_dns1 and expected_dns1 not in current['dns']:
        print(f"❌ Primary DNS {expected_dns1} not found in current DNS list: {current['dns']}")
        all_match = False
    elif expected_dns1:
        print(f"✅ Primary DNS {expected_dns1} is configured")

    if expected_dns2 and expected_dns2 not in current['dns']:
        print(f"⚠️ Secondary DNS {expected_dns2} not found (may not be critical)")
        # Not failing the validation because secondary DNS is optional

    if all_match:
        print("✅ Validation passed. The interface is correctly configured.")
    else:
        print("❌ Validation failed. Configuration does not match expectations.")
    return all_match

# ----------------------------------------------------------------------
# Main CLI
# ----------------------------------------------------------------------
def main():
    if not is_admin():
        print("⏫ Requesting administrator privileges...")
        run_as_admin()
        return

    parser = argparse.ArgumentParser(description="Set or validate static IP on Windows")
    parser.add_argument("--list", action="store_true", help="List available interfaces")
    parser.add_argument("--validate", action="store_true", help="Validate current settings (optionally compare with expected values)")
    parser.add_argument("--interface", help="Network interface name")
    parser.add_argument("--ip", help="Static IP address")
    parser.add_argument("--subnet", default="255.255.255.0", help="Subnet mask")
    parser.add_argument("--gateway", help="Default gateway")
    parser.add_argument("--dns1", help="Primary DNS")
    parser.add_argument("--dns2", help="Secondary DNS")

    args = parser.parse_args()

    if args.list:
        list_network_interfaces()
        return

    if args.validate:
        if not args.interface:
            print("❌ --interface is required for validation.")
            sys.exit(1)
        # If no expected values provided, just show current config
        if not (args.ip or args.subnet or args.gateway or args.dns1):
            current = get_current_interface_config(args.interface)
            if current:
                print(f"\nCurrent configuration for '{args.interface}':")
                print(f"  IP Address: {current['ip']}")
                print(f"  Subnet Mask: {current['subnet']}")
                print(f"  Default Gateway: {current['gateway']}")
                print(f"  DNS Servers: {', '.join(current['dns']) if current['dns'] else 'None'}")
            else:
                print(f"❌ Could not retrieve configuration for '{args.interface}'")
            sys.exit(0)
        else:
            validate_static_ip(args.interface, args.ip, args.subnet, args.gateway, args.dns1, args.dns2)
        return

    # Set mode
    if not (args.interface and args.ip and args.gateway and args.dns1):
        parser.print_help()
        print("\n❌ Error: --interface, --ip, --gateway, and --dns1 are required for setting IP.")
        sys.exit(1)

    if set_static_ip(args.interface, args.ip, args.subnet, args.gateway, args.dns1, args.dns2):
        print("\n🧪 Running validation after setting...")
        validate_static_ip(args.interface, args.ip, args.subnet, args.gateway, args.dns1, args.dns2)

if __name__ == "__main__":
    main()
# python set_static_ip.py --interface "Wi-Fi" --ip 192.168.1.100 --gateway 192.168.1.1 --dns1 8.8.8.8    

# Reverting to Dynamic (DHCP)
# To go back to automatic IP, run these commands as Admin:

# cmd
# netsh interface ip set address "Wi-Fi" dhcp
# netsh interface ip set dns "Wi-Fi" dhcp

# Usage Examples
# 1. Set a static IP (auto‑validates after applying)
# cmd
# python set_static_ip.py --interface "Ethernet" --ip 192.168.1.100 --gateway 192.168.1.1 --dns1 8.8.8.8 --dns2 8.8.4.4
# 2. Validate current settings (just view)
# cmd
# python set_static_ip.py --validate --interface "Ethernet"
# 3. Validate against expected values
# cmd
# python set_static_ip.py --validate --interface "Ethernet" --ip 192.168.1.100 --gateway 192.168.1.1 --dns1 8.8.8.8
# 4. List interfaces
# cmd
# python set_static_ip.py --list
# ✅ What --validate does
# Reads the current IP, subnet mask, gateway, and DNS servers from Windows (using netsh).

