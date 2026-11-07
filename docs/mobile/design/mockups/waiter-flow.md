# Wireframes — Waiter flow

Mesas -> (Abrir mesa) -> Ticket -> Menú -> Configurar -> Pedido por enviar -> Ticket -> Listos

## W-01 Floor
```
┌──────────────────────────┐
│ Mesas   (● En línea) (MR)│
│ [Bar cerrado: pide abrir turno]   <- only if no cash session
│ BILLAR          3 ocupadas│
│ ┌────────┐ ┌────────┐    │
│ │BT1 Ocup│ │BT2 Libre│   │
│ │Carlos  │ │         │   │
│ │ 1:23:05│ │         │   │
│ └────────┘ └────────┘    │
│ [BT3] [BT4 Cuenta] ...   │
│ MESAS                    │
│ [T1] [T2] [T3 Cuenta]    │
│ BARRA                    │
│ [B1] [B2] [B3]           │
│ [Mesas] [Listos 2] [Yo]  │
└──────────────────────────┘
 toast (top): Listo: Alitas BBQ 10 pz · T4  [Ver]
```

## W-07 Abrir mesa (sheet)
```
│ Abrir BT2                │
│ Nombre del cliente (opc.)│
│ {                      } │
│ [▓ Abrir mesa          ] │
```

## W-02 Ticket
```
┌──────────────────────────┐
│ ‹ Billar BT1 (● En línea)│
│   Carlos M. · abierta 20:24
│ Tiempo de mesa  (Ocupada)│
│ 1:23:05          $120/h  │
│ [2 productos por enviar ›]
│ 3× Cerveza Corona  $135  │ (Servido)
│ 1× Alitas BBQ 10 pz $145 │ (En preparación)
│    Salsa: Búfalo         │
│ 1× Hamburguesa      $119 │ (Enviado)
│    nota: sin cebolla     │
│ 1× Papas             $65 │ (Listo)
│ 1× Coca-Cola (tachado)   │ (Cancelado)
│ Consumo            $529  │
│ Tiempo (estimado) ≈ $166 │
│ [▓ Agregar productos][Pedir cuenta]
└──────────────────────────┘
```

## W-03 Menú  /  W-04 Configurar
```
┌──────────────────────────┐   ┌──────────────────────────┐
│ ‹ Agregar a BT1          │   │ (menú atenuado)          │
│ {Buscar producto        }│   │ ╭──────────────────────╮ │
│ (Todo)(Alitas)(Comida)(Ce│   │ │ Alitas BBQ 10 pz  ✕  │ │
│ [Alitas BBQ 1][Hambur. 1]│   │ │ Salsa  Obligatorio 1-2│ │
│ [Papas][Nachos]          │   │ │ [x] BBQ              │ │
│ [Corona][Michelada]      │   │ │ [ ] Búfalo           │ │
│ [Margarita][Tacos:Agotado]│  │ │ [x] Mango habanero   │ │
│ [▓ Revisar pedido (2)]   │   │ │ Aderezo  Opcional    │ │
└──────────────────────────┘   │ │ Notas {bien doradas} │ │
                               │ │ (− 2 +) [▓ Agregar]  │ │
                               │ ╰──────────────────────╯ │
                               └──────────────────────────┘
```

## W-05 Pedido por enviar
```
┌──────────────────────────┐
│ ‹ Pedido por enviar      │
│ !! 1 producto no se envió│
│ 1× Alitas BBQ    (Enviado)
│ 1× Hamburguesa  (Enviando…)
│ 1× Papas (No se envió) [↻ Reintentar]
│ 2× Michelada (Por enviar) (− 2 +)
│ Subtotal estimado  $459  │
│ [▓ Reintentar (2)]       │      default: [▓ Enviar (4)]
└──────────────────────────┘
```

## W-06 Listos
```
│ Listos   4 esperando     │
│ T4 · Sofía     [Servir todo (2)]
│  2× Alitas BBQ · Cocina · listo hace 2:10  [Marcar servido]
│  1× Papas · listo hace 0:45                [Marcar servido]
│ B1 · Beto
│  3× Cerveza Corona · Barra · 1:20          [Marcar servido]
│ [Mesas] [Listos 2] [Yo]
```

## OV-01 PIN gerente
```
│   PIN de gerente         │
│ Para cancelar Michelada… │
│       ● ● ○ ○            │
│  1  2  3                 │
│  4  5  6                 │
│  7  8  9                 │
│  ✕  0  ⌫                 │
│ [Cancelar] [░ Confirmar] │
```
