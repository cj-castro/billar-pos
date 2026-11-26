# Instalar Bola 8 Staff en iPhone (versión de prueba interna)

Versión 1.2.0 (compilación 5). Solo para el personal y socios del club.

Esta app **no está en la App Store**. Es una versión de prueba interna que se instala con una herramienta
gratuita llamada **Sideloadly**, usando **tu propio Apple ID** (el mismo de tu iPhone; no cuesta nada).
Apple limita estas instalaciones: **la app deja de abrir a los 7 días** y hay que renovarla (ver "Renovar cada semana").

Necesitas: un iPhone con iOS 16.4 o más nuevo, su cable de carga (USB), una computadora (Windows o Mac)
con internet, tu Apple ID y el archivo `bola8-staff-1.2.0-5-unsigned.ipa` que te mande el encargado.

## 1. Preparar la computadora

### Mac
1. Descarga **Sideloadly** desde **https://sideloadly.io** (botón para macOS) y arrástralo a Aplicaciones.
2. Ábrelo. Si macOS dice que no se puede verificar, abre **Ajustes del Sistema > Privacidad y seguridad** y toca **Abrir de todos modos**.

### Windows
1. Instala **iTunes** y **iCloud** descargándolos **de la página de Apple** (apple.com), **no** de la tienda Microsoft Store.
   Las versiones de Microsoft Store no funcionan con Sideloadly. Si ya las tienes de la Microsoft Store, desinstálalas primero.
2. Descarga **Sideloadly** desde **https://sideloadly.io** (versión Windows) e instálalo.
3. Reinicia la computadora si te lo pide.

## 2. Preparar el iPhone
1. Conecta el iPhone a la computadora con el cable. Desbloquéalo y, si pregunta **¿Confiar en esta computadora?**, toca **Confiar** e ingresa tu código.
2. Activa el **Modo de desarrollador**: **Ajustes > Privacidad y seguridad > Modo de desarrollador** (está hasta abajo).
   Enciéndelo; el iPhone se reiniciará. Al volver a encender, desbloquéalo y toca **Activar** cuando pregunte.
   *Si no ves la opción "Modo de desarrollador", haz primero el paso 3 y regresa aquí: aparece después del primer intento de instalar.*

## 3. Instalar la app
1. Abre **Sideloadly**. Arriba debe aparecer tu iPhone (si no, desconecta y vuelve a conectar el cable).
2. En **Apple ID**, escribe tu correo de Apple. Al tocar **Start** te pedirá la contraseña y, después, el **código de verificación de 6 dígitos**
   que llega a tus otros dispositivos Apple. Tu contraseña se usa solo para firmar la app; nadie del club la recibe.
3. **Arrastra** el archivo `bola8-staff-1.2.0-5-unsigned.ipa` a la ventana de Sideloadly.
4. Toca **Start** y espera (1 a 3 minutos). Cuando diga **Done**, la app ya está en tu pantalla de inicio.

## 4. Primer inicio: confiar en tu Apple ID
Al abrirla por primera vez aparecerá **"Desarrollador no confiable"**. Es normal:
1. Ve a **Ajustes > General > VPN y gestión de dispositivos**.
2. Bajo "App de desarrollador", toca tu **Apple ID** (tu correo) y luego **Confiar**.
3. Regresa y abre **Bola 8 Staff**. Si el iPhone pregunta por **Red local**, toca **Permitir** (si no, no podrá hablar con el servidor).

## 5. Conectarte al servidor del bar desde otra ciudad
La app habla con el servidor que está en el bar. Fuera del Wi-Fi del bar necesitas **Tailscale** (gratis), una red privada segura:
1. Instala **Tailscale** desde la App Store en el iPhone.
2. El encargado te invitará a su red (**tailnet**) o compartirá contigo el servidor del bar. Acepta la invitación e inicia sesión en Tailscale; el interruptor debe quedar **encendido (conectado)**.
3. Abre **Bola 8 Staff**. La app ya incluye la dirección de Tailscale del bar (`100.78.80.83:8080`) en su lista y debería encontrarlo sola.
4. Si no lo encuentra, en la pantalla de configuración escribe la dirección manualmente: `http://100.78.80.83:8080`.
5. Inicia sesión con el usuario y contraseña que te dé el encargado.

(Estando en el Wi-Fi del bar no hace falta Tailscale; la app encuentra el servidor sola.)

## Renovar cada semana (muy importante)
Con Apple ID gratuito la app **caduca a los 7 días** y deja de abrir (los datos no se pierden). Dos opciones:
- **Automático:** deja Sideloadly abierto en la computadora (que siga encendida) y en la **misma red Wi-Fi** que el iPhone. Su servicio de renovación automática
  (**Auto Refresh / daemon**) lo renueva solo mientras la computadora esté encendida y el iPhone esté en esa red. Actívalo la primera vez que Sideloadly lo ofrezca.
- **Manual:** una vez por semana, repite el paso 3 (arrastrar el `.ipa` y **Start**). Se instala encima y conserva tus datos.

## Problemas comunes
- **Sideloadly no ve el iPhone:** cambia de cable/puerto, desbloquea el iPhone, toca **Confiar**; en Windows confirma que iTunes e iCloud son los de apple.com, y ábrelos una vez.
- **Error de inicio de sesión / "app-specific password":** entra a **appleid.apple.com**, crea una *contraseña de app* y úsala en Sideloadly en lugar de tu contraseña normal.
- **"Maximum number of apps" / límite de apps:** el Apple ID gratuito permite solo 3 apps de este tipo a la vez y un número limitado de instalaciones por semana. Borra otra app instalada con Sideloadly o espera unos días.
- **Falta "Modo de desarrollador":** intenta instalar una vez (paso 3) y revisa de nuevo Ajustes > Privacidad y seguridad.
- **La app no abre y se cierra sola:** pasaron más de 7 días; reinstala con Sideloadly.
- **"Desarrollador no confiable":** repite el paso 4.
- **No conecta al servidor:** revisa que Tailscale esté encendido (o que estés en el Wi-Fi del bar), que Red local esté permitida (**Ajustes > Bola 8 Staff > Red local**) y escribe la dirección manual del paso 5.
- **Cualquier otro error:** toma una captura de pantalla del mensaje y mándasela al encargado.
