# backend/app/services/printer_service.py
import os
import json
from typing import Dict, Any
from escpos.printer import Serial, Usb, Network
from app.models.ticket import TicketModel

class ThermalPrinterService:
    def __init__(self):
        # Configure for your Sendowtek printer
        # Try different connection methods:
        self.printer = None
        
        # Option 1: USB (most common for thermal printers)
        # self.printer = Usb(0x0456, 0x0808)  # Vendor ID, Product ID
        
        # Option 2: Serial/Bluetooth (if paired as serial)
        # self.printer = Serial(devfile='/dev/rfcomm0', baudrate=9600)
        
        # Option 3: For Web Bluetooth, you won't use backend at all!
        pass
    
    def format_ticket_receipt(self, ticket_data: Dict[str, Any]) -> str:
        """Reuse their ticket grouping logic from v1.002"""
        receipt_lines = []
        
        # Header
        receipt_lines.append("=" * 32)
        receipt_lines.append("     BILLIARD BAR POS")
        receipt_lines.append("=" * 32)
        receipt_lines.append(f"Ticket: #{ticket_data['id']}")
        receipt_lines.append(f"Table: {ticket_data.get('table', 'N/A')}")
        receipt_lines.append(f"Time: {ticket_data['created_at']}")
        receipt_lines.append("-" * 32)
        
        # Items (using their grouped format from v1.002)
        for category, items in ticket_data.get('grouped_items', {}).items():
            receipt_lines.append(f"\n{category}:")
            for item in items:
                quantity = item.get('quantity', 1)
                name = item['name']
                price = item['price']
                receipt_lines.append(f"  {quantity}x {name:<20} ${price:.2f}")
        
        receipt_lines.append("-" * 32)
        receipt_lines.append(f"Total: ${ticket_data['total']:.2f}")
        receipt_lines.append("=" * 32)
        receipt_lines.append("\n\n")
        
        return "\n".join(receipt_lines)