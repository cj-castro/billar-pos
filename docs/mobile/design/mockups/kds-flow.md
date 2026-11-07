# Wireframes — Kitchen / Bar KDS

## Portrait (1 column, 22 dp item text)
```
┌──────────────────────────┐
│ Cocina (Cocina|Barra) (● En línea)
│ ┌[borde rojo]────────────┐
│ │ BT1  Carlos M.  [⏱ 23:10 ROJO]
│ │▌1×  Alitas BBQ 10 pz   [ Listo ▓]   <- franja ámbar = En preparación
│ │     Salsa: Búfalo      │
│ │ 1×  Papas a la francesa[ Iniciar ]  <- franja gris = Enviado
│ │ [ ✓ Todo listo ]       │
│ └────────────────────────┘
│ ┌[borde ámbar]───────────┐
│ │ T4  Sofía       [⏱ 12:40 ÁMBAR]
│ │▌1×  Hamburguesa clásica[ Listo ▓]
│ │     [nota: sin cebolla]  <- chip ámbar sólido, negrita
│ │ 2×  Nachos con queso   [ Iniciar ]
│ └────────────────────────┘
│ ┌ T7 Equipo 3  [⏱ 3:05 gris] ...
└──────────────────────────┘
```

## Landscape (3 columns, horizontal scroll)
```
┌──────────────────────────────────────────────────────────────┐
│ Cocina [5 pendientes] (Cocina|Barra)         🔊 (● En línea) │
│ ┌BT1 ⏱23:10┐ ┌T4 ⏱12:40┐ ┌T7 ⏱3:05┐ →                         │
│ │ items…   │ │ items…  │ │ items… │                          │
│ │[Todo listo]│[Todo listo]│[Todo listo]                       │
└──────────────────────────────────────────────────────────────┘
```
Row tap: SENT -> IN_PROGRESS -> READY (one step per tap). READY shows "Listo ✓" (green) + 3 s Deshacer. Oldest first. Empty state: big check "Sin pedidos pendientes".
