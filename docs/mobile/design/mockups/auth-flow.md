# Wireframes — Auth & cross-cutting

## SCR-AUTH-01 ServerSetup  ->  SCR-AUTH-02 Login
```
┌──────────────────────────┐    ┌──────────────────────────┐
│        (logo 96)         │    │        (logo 72)         │
│   Conecta con tu bar     │    │   Hola, inicia sesión    │
│ Escribe la direccion del │    │ (192.168.1.20:8080 ·     │
│ servidor del POS.        │    │            Cambiar)      │
│                          │    │ !! Usuario o contraseña  │
│ Dirección del servidor   │    │    incorrectos.          │
│ {http://192.168.1.20:8080}    │ Usuario                  │
│ [ Probar conexión ]      │    │ {mariana              }  │
│ ✓ Conexión exitosa 38 ms │    │ Contraseña               │
│                          │    │ {••••••••          (ojo)}│
│ [▓ Continuar          ]  │    │ [▓ Entrar             ]  │
│        ( ES | EN )       │    │        ( ES | EN )       │
└──────────────────────────┘    └──────────────────────────┘
```

## Offline banner + connection pill (any signed-in screen)
```
┌──────────────────────────┐
│ Mesas       (● Sin conex.)│
│ !! Sin conexión · datos  │
│    de hace 3 min         │
│ ... cached content 70% ..│
│ [░ Enviar (n) ░]         │
│  Necesitas conexión      │
└──────────────────────────┘
```

## SCR-X-01 AccessDenied / SCR-X-02 Error
```
┌──────────────────────────┐   ┌──────────────────────────┐
│          (escudo)        │   │          ( ! )           │
│ Esta sección no es para  │   │ No pudimos cargar las    │
│ tu rol                   │   │ mesas                    │
│ [▓ Ir a mi pantalla]     │   │ Código: SERVER_ERROR     │
│ [ Cerrar sesión ]        │   │ [▓ Reintentar] Ver det.  │
└──────────────────────────┘   └──────────────────────────┘
```

## SCR-AUTH-00 Splash
```
│        (logo 96)         │
│    Bola 8 Pool Club      │
│  Restaurando tu sesión…  │
│  ▓▓▓▓▓▓░░░░░             │
```
