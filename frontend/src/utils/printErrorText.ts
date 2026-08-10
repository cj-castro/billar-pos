const MESSAGES: Record<string, string> = {
  PRINTER_OFFLINE: 'Impresora desconectada — revisa el Bluetooth/USB y vuelve a intentar',
  PRINTER_ERROR: 'La impresora reportó un error — revisa que tenga papel',
  AGENT_UNREACHABLE: 'El agente de impresión no está corriendo en la computadora del bar',
  PRINT_UNKNOWN: 'No se pudo imprimir — intenta de nuevo',
}

export function getPrintErrorMessage(errorCode?: string): string {
  if (errorCode && errorCode in MESSAGES) return MESSAGES[errorCode]
  return MESSAGES.PRINT_UNKNOWN
}
