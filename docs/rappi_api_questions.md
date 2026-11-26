Asunto: Preguntas sobre integración — webhook de int-public-api-v2 + callbacks de ciclo de vida (ID de tienda [TU_ID_DE_TIENDA])

Hola, equipo,

Estamos construyendo nuestra integración con int-public-api-v2 para nuestra tienda [NOMBRE_TIENDA] (ID de tienda [ID_TIENDA], país [PAÍS — ej. México]). Tenemos OAuth2 funcionando en el entorno de desarrollo (https://microservices.dev.rappi.com/api/v2/restaurants-integrations-public-api) y podemos consultar /menu y /orders/status/sent. Antes de continuar, necesitamos aclaración sobre algunos puntos que la documentación pública no especifica completamente. Los numeramos para que sea más fácil responder.

Webhooks

Verificación de firma. Cuando hacen el POST a nuestro webhook de order.created, ¿qué header contiene la firma y cuál es el algoritmo? Nuestra suposición actual es HMAC-SHA256 del cuerpo crudo de la solicitud, header X-Rappi-Signature, secreto compartido al momento del registro. Por favor confirme o corrija.

Rotación del secreto de la firma. ¿Cómo rotamos el secreto del webhook? ¿Está vinculado al client_secret o es un valor separado?

Comportamiento de reintentos ante respuestas no 2xx. Si nuestro endpoint responde con 5xx o se agota el tiempo de espera, ¿cuántos reintentos hacen, con qué espera (backoff) y hay algún tipo de "dead-letter" por fallos de entrega que podamos consultar?

Registro. PUT /webhook/{event}/add-stores — ¿la URL que registramos debe estar accesible públicamente al momento de la llamada, o ustedes encolan una verificación? ¿Hay algún evento de prueba o ping que podamos activar para validar el endpoint antes de entrar en producción?

Por tienda vs por cuenta. Si registramos un webhook para un ID de tienda, ¿se aplica a todas las tiendas de nuestra cuenta, o estrictamente a esa tienda?

URL base de producción

Por favor confirme la URL base de producción para [PAÍS]. Suponemos que es https://services.rappi.com.[CC]/api/v2/restaurants-integrations-public-api, pero queremos estar seguros del valor exacto de {COUNTRY_DOMAIN} antes de definir las variables de entorno de producción.

Estructura del pedido (payload)

Modificadores (toppings). En el payload de order.created, ¿los toppings/modificadores aparecen anidados debajo de cada ítem (hijos), como un arreglo hermano (sibling) con clave por línea del padre, o ambas? Un ejemplo de payload del entorno de desarrollo resolvería todas nuestras dudas.

Precios de los ítems en el payload. Si nuestro precio local de un producto difiere del que Rappi tiene en caché para nosotros (por ejemplo, si actualizamos el precio después de que el cliente comenzó a ordenar), ¿qué precio es el autorizado para la factura del cliente? Nuestro plan es confiar en nuestros precios para inventario/totales y registrar el precio de Rappi para conciliación — indíquenos si esto es incorrecto.

tracking_url. ¿Se incluye una URL de seguimiento para el cliente/repartidor en el payload del pedido? Si es así, ¿cuál es el nombre del campo? Si no, ¿existe una URL determinista que podamos construir a partir del orderId para codificarla en nuestro código QR de la hoja de ruta del repartidor (ej. https://www.rappi.com.[CC]/track/{orderId})?

Callbacks de ciclo de vida

Idempotencia. ¿PUT /orders/{id}/take/{cookingTime}, PUT /orders/{id}/reject y POST /orders/{id}/ready-for-pickup son idempotentes de su lado, o llamadas duplicadas devuelven un error? Nosotros prevenimos duplicados en nuestra parte, pero queremos saber qué esperar si un reintento de red pasa.

Límites de cookingTime. ¿Cuáles son los valores mínimo y máximo para cookingTime (en minutos)? Por defecto pensamos enviar 20 a menos que el cocinero indique otro valor.

Motivos de rechazo. El cuerpo de PUT /orders/{id}/reject, ¿es texto libre o un vocabulario controlado (enum de códigos)? Si es un enum, ¿cuáles son los valores válidos? Específicamente para los casos de OUT_OF_STOCK y UNMAPPED_ITEM.

Marcado de "ready" tardío. Si marcamos un pedido como listo (ready) después de que el repartidor ya llegó o se fue, ¿qué pasa de su lado? ¿Debemos llamar al endpoint igualmente para el registro de auditoría, o hay un punto de corte?

Sincronización de menú

Frecuencia. ¿Con qué frecuencia esperan que volvamos a consultar GET /menu para detectar cambios que ustedes hayan hecho del lado de Rappi (por ejemplo, que un equipo de operaciones del partner active/desactive un producto)? ¿Existe un campo lastModified en los productos para poder hacer un diff ligero?

Estabilidad del SKU. Una vez que se asigna un SKU de Rappi, ¿es estable durante toda la vida del producto o puede cambiar? Estamos usando ese SKU como clave en nuestra tabla de mapeo interno.

Autenticación

TTL del token. Los documentos dicen que el access token expira en 1 semana. ¿Es exacto o es una garantía de "≥ 1 semana"? Nosotros refrescamos proactivamente a los 6 días, pero queremos confirmar que no hay un límite más corto que debamos considerar.

Tokens concurrentes. Si emitimos un token nuevo antes de que expire el anterior, ¿ambos son válidos hasta su expiración individual, o el nuevo token invalida al viejo?

Pruebas / Sandbox

¿Existe alguna forma de inyectar un pedido de prueba sintético en el entorno de desarrollo con nuestro ID de tienda para poder ejercitar todo el flujo (webhook → take → ready → picked-up) sin tráfico real de clientes? Si es así, por favor comparta los pasos.

Nos encantaría agendar una llamada de 30 minutos si alguno de estos puntos requiere explicación en vivo. De lo contrario, las respuestas por escrito son geniales — las incorporaremos en nuestras pruebas de integración.

Gracias,

[TU NOMBRE]
[TU PUESTO]
[NOMBRE_TIENDA] — [CIUDAD, PAÍS]
[TU CORREO / TELÉFONO]