# Role-Based User Flows

Mermaid flowcharts. Screen IDs: [SCREEN_INVENTORY.md](./SCREEN_INVENTORY.md). API behaviour: [BUSINESS_RULES.md](../discovery/BUSINESS_RULES.md), [API_CAPABILITY_MATRIX.md](../discovery/API_CAPABILITY_MATRIX.md). Decisions D5–D10: [PROJECT_STATE.md](../PROJECT_STATE.md).

## 1. First launch

```mermaid
flowchart TD
  A["Instalar y abrir app"] --> B["SCR-AUTH-00 Splash"]
  B --> C{"URL guardada?"}
  C -- no --> D["SCR-AUTH-01 Servidor"]
  D --> E["Escribe http://IP:8080"]
  E --> F{"Formato válido?"}
  F -- no --> E1["Error de formato"] --> E
  F -- si --> G["Probar conexión: GET /api/v1/health"]
  G --> H{"status = ok?"}
  H -- "timeout / DNS / 404" --> I["Fila roja con causa"] --> E
  H -- si --> J["Fila verde + latencia"]
  J --> K["Continuar (guarda URL)"]
  K --> L["SCR-AUTH-02 Login"]
  C -- si --> L
```

## 2. Login and session restore

```mermaid
flowchart TD
  S["Splash"] --> T{"Tokens en SecureStore?"}
  T -- no --> L["Login"]
  T -- si --> R["POST /auth/refresh"]
  R -- "200" --> ME["GET /auth/me"]
  R -- "401 / 422 / USER_INACTIVE" --> CL["Borrar tokens"] --> L2["Login + aviso: Tu sesión expiró"]
  R -- "sin red / 5xx" --> OFF["Entrar con usuario en caché + banner offline"]
  ME --> HOME["Home por rol"]
  OFF --> HOME
  L --> U["Usuario + contraseña"]
  U --> V{"Campos llenos?"}
  V -- no --> U
  V -- si --> P["POST /auth/login"]
  P -- "200" --> SAVE["Guardar tokens (SecureStore) + user"] --> HOME
  P -- "401 INVALID_CREDENTIALS" --> ERR["Ver flujo 8"]
  P -- "429" --> RL["Espera 1 minuto"] --> U
```

## 3. Role entry (D9)

```mermaid
flowchart LR
  H["Sesión válida"] --> R{"role"}
  R -- WAITER --> F["Mesas"]
  R -- KITCHEN_STAFF --> K["KDS Cocina"]
  R -- BAR_STAFF --> B["KDS Barra"]
  R -- MANAGER --> O["Resumen"]
  R -- ADMIN --> O2["Resumen + Sistema"]
  R -- otro --> X["Acceso denegado"]
```

## 4. Waiter: select table, add items, modifiers, send

```mermaid
flowchart TD
  F["SCR-W-01 Mesas"] --> Q{"Bar abierto? (caja)"}
  Q -- "no" --> BC["Banner: Bar cerrado"] --> F
  Q -- si --> TT{"Estado de la mesa"}
  TT -- Libre --> OT["Abrir mesa (nombre opcional)"]
  OT --> API1["POST /tickets"]
  API1 -- "409 RESOURCE_OCCUPIED" --> OCC["Aviso: ya la abrieron"] --> TK
  API1 -- "403 BAR_CLOSED" --> BC
  API1 -- "201" --> TK["SCR-W-02 Ticket"]
  TT -- "Ocupada / Cuenta" --> TK
  TK --> ADD["Agregar productos"]
  ADD --> M["SCR-W-03 Menú: categoría / buscar"]
  M --> IT{"Producto"}
  IT -- "Agotado" --> M
  IT -- "sin opciones" --> D1["Agrega 1 al borrador local"] --> M
  IT -- "con opciones" --> CF["SCR-W-04 Configurar"]
  CF --> VAL{"Grupos obligatorios completos?"}
  VAL -- no --> CF
  VAL -- si --> D2["Agregar al borrador (qty, notas)"] --> M
  M --> RV["Revisar pedido (n)"]
  RV --> DR["SCR-W-05 Pedido por enviar"]
  DR --> EDIT["Ajustar cantidad / quitar"] --> DR
  DR --> SEND["Enviar (n)"]
  SEND --> LOOP["Por cada línea: POST /tickets/id/items + Idempotency-Key"]
  LOOP -- "201 / 200 duplicado" --> OKL["Línea: Enviado"]
  LOOP -- "422 OUT_OF_STOCK" --> STK["Línea: Agotado, quitar o cambiar"] --> DR
  LOOP -- "error de red" --> FAIL["Línea: No se envió"] --> DR
  OKL --> ALL{"Todas enviadas?"}
  ALL -- no --> LOOP
  ALL -- si --> DONE["Toast: Pedido enviado, vuelve al Ticket"] --> TK
```

## 5. Kitchen: receive, progress

```mermaid
flowchart TD
  W["Mesero envía línea (SENT)"] --> SRV["Servidor: kitchen:update / bar:update"]
  SRV --> NEW["KDS: aparece tarjeta (háptico + sonido opcional)"]
  NEW --> AG["Edad desde sent_at: gris, ámbar 10 min, rojo 20 min"]
  AG --> TAP1["Toque en fila: SENT -> IN_PROGRESS"]
  TAP1 --> P1["PATCH /queue/id/status IN_PROGRESS"]
  P1 -- ok --> S1["Fila ámbar: En preparación"]
  P1 -- error --> RB["Revertir + aviso"] --> TAP1
  S1 --> TAP2["Toque en fila: IN_PROGRESS -> READY"]
  TAP2 --> P2["PATCH status READY"]
  P2 -- ok --> S2["Fila verde: Listo + Deshacer 3 s"]
  S2 --> ALLR{"Todas las filas listas?"}
  ALLR -- si --> HOLD["Tarjeta: Esperando mesero (sale al servirse)"]
  ALLR -- no --> TAP1
  NEW -. "atajo" .-> TODO["Todo listo: confirma si hay SENT sin iniciar"] --> S2
```

## 6. Waiter: ready, served

```mermaid
flowchart TD
  K["Cocina/Barra marca READY"] --> EV["Socket: ticket:item_status / kitchen:item_update"]
  EV --> F{"Línea es de mi ticket?"}
  F -- no --> IGN["Ignorar"]
  F -- si --> TO["Toast: Listo - producto - mesa + háptico"]
  TO --> BADGE["Badge en tab Listos +1"]
  TO -- "Ver" --> TK["Ticket (chip Listo)"]
  BADGE --> LS["SCR-W-06 Listos"]
  LS --> SV["Marcar servido"]
  SV --> API["PATCH /queue/id/status SERVED"]
  API -- ok --> GONE["Línea sale de Listos; chip Servido en Ticket"]
  API -- error --> RT["Aviso + reintentar"] --> SV
  LS --> ALL["Servir todo (n)"] --> API
```

## 7. Manager review

```mermaid
flowchart TD
  M["Login MANAGER"] --> O["SCR-M-01 Resumen"]
  O --> C{"Caja abierta?"}
  C -- no --> CC["Tarjeta: Caja cerrada (abrir en POS)"]
  C -- si --> TL["Tiles: tickets, cuentas, cocina, barra"]
  TL --> AL{"Alertas?"}
  AL -- "item > 20 min" --> A1["Alerta roja -> KDS estación"]
  AL -- "cuenta solicitada > 10 min" --> A2["Alerta ámbar -> Ticket"]
  AL -- ninguna --> OK["Sin alertas"]
  TL --> T["Tickets abiertos"]
  T --> TD["Ticket (lectura)"]
  TD --> ACT{"Acción de gerente"}
  ACT -- "Anular producto" --> PIN["PIN gerente"] --> CONF["Confirmar destructivo"] --> API["DELETE item con pin"]
  ACT -- "Descuento" --> DS["Porcentaje + confirmar (token de gerente)"]
  ACT -- ninguna --> T
```

## 8. Network loss during send, and recovery

```mermaid
flowchart TD
  S["Enviar (3 líneas, claves K1 K2 K3)"] --> L1["POST línea 1 K1: 201"]
  L1 --> L2["POST línea 2 K2"]
  L2 -- "se cae la red" --> U{"Respuesta recibida?"}
  U -- "no (estado desconocido)" --> MARK["Línea 2 y 3: No se envió"]
  U -- "error HTTP claro" --> MARK
  MARK --> BAN["Banner offline + helper: se envía cuando vuelva"]
  BAN --> KEEP["Borrador persiste en disco (D7)"]
  KEEP --> REC["Reconexión: socket + NetInfo"]
  REC --> RF["Refetch ticket (compara líneas)"]
  RF --> CH{"Servidor tiene B1 Idempotency-Key?"}
  CH -- si --> RS["Reintentar con las mismas K2 K3: duplicado devuelve la línea existente (200)"]
  CH -- "no (B1 ausente)" --> CMP["Comparar por texto/cantidad/hora; si ya existe, marcar Enviado sin reenviar"]
  CMP --> RS2["Reenviar solo las faltantes"]
  RS --> OKF["Todas Enviado: Toast y limpiar borrador"]
  RS2 --> OKF
```

Rules: Enviar disabled while any request is in flight; line status is per line; keys are generated when the line is created in the draft (not at send time) and persisted with it.

## 9. Invalid credentials

```mermaid
flowchart TD
  L["Login: usuario + contraseña"] --> P["POST /auth/login"]
  P -- "401 INVALID_CREDENTIALS" --> E["Fila roja: Usuario o contraseña incorrectos"]
  E --> F["Limpiar contraseña, foco en contraseña, háptico Error"]
  F --> N{"3 intentos seguidos?"}
  N -- no --> L
  N -- si --> H["Ayuda: Pídele a tu gerente restablecer tu acceso"] --> L
  P -- "429" --> RL["Espera 1 min (el límite es compartido por todo el bar)"] --> L
  P -- "sin red" --> OF["Banner offline, Entrar deshabilitado"]
```

## 10. Authorization denial

```mermaid
flowchart TD
  A["Navegar a ruta o deep link"] --> G{"Rol permitido en el grupo?"}
  G -- si --> OK["Mostrar pantalla"]
  G -- no --> X["SCR-X-01 Acceso denegado"]
  X --> H["Ir a mi pantalla (home por rol)"]
  X --> LO["Cerrar sesión"]
  API["Acción con permiso insuficiente (403 FORBIDDEN / MANAGER_REQUIRED)"] --> T["Toast: No tienes permiso para eso"]
  API2["Anular producto como mesero"] --> PIN["PIN gerente"]
  PIN -- "válido" --> RUN["Ejecuta con pin"]
  PIN -- "inválido" --> ERR["PIN incorrecto, reintentar"]
  PIN -- "429" --> RLP["Espera, teclado deshabilitado"]
```

## 11. Logout

```mermaid
flowchart TD
  Y["Yo / Sistema: Cerrar sesión"] --> D{"Hay borrador sin enviar?"}
  D -- si --> C1["Confirmar: se borrará tu pedido sin enviar"]
  D -- no --> C2["Confirmar: ¿Cerrar sesión?"]
  C1 -- Cancelar --> Y
  C2 -- Cancelar --> Y
  C1 -- Confirmar --> X
  C2 -- Confirmar --> X["POST /auth/logout (si hay red; si no, continuar)"]
  X --> W["Borrar tokens, usuario, borradores del usuario, cache de consultas"]
  W --> S["Salir de salas socket y desconectar"]
  S --> L["Login (URL del servidor se conserva)"]
```

Note: `/auth/logout` only blocklists the access token; refresh token is NOT revoked server-side (G3) so the device-side wipe is the real logout.
