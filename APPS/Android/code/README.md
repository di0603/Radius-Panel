# didev VPN para Android

Frontend Android derivado de `src/frontends/android` de strongSwan. El motor
IKEv2 (`libcharon`) no se modifica. Los avisos de copyright de upstream se
conservan y todo el frontend sigue GPLv2; ver `LICENSE-GPLv2.txt`.

## Build reproducible

El proyecto fija AGP 8.13.0, Gradle wrapper 8.13, NDK 27.3.13750724, SDK 36,
Build Tools 35.0.0 y las versiones de AndroidX/Bouncy Castle/ZXing/WorkManager
en `app/build.gradle`. Requiere Android SDK instalado y `ANDROID_HOME`.

```powershell
.\build.ps1 -Version 1.0.0
```

La clave de firma nunca vive en este repositorio. Con
`DIDEV_ANDROID_SIGNING_KEYSTORE`, `DIDEV_ANDROID_SIGNING_ALIAS`,
`DIDEV_ANDROID_SIGNING_STORE_PASSWORD` y `DIDEV_ANDROID_SIGNING_KEY_PASSWORD`
se firma el APK fuera del árbol. Sin ellas el script avisa y deja un APK local
de depuración. Los resultados se escriben en `../ejecutables/`.

## Aprovisionamiento y confianza

El sobre se verifica sobre los bytes originales del payload, valida Ed25519 y
comprueba que `signerKeySha256` corresponde a `signerPublicKey`. Se aceptan
versiones conocidas y perfiles no caducados. `full` valida su cadena; `qr`
obtiene `/.well-known/est/cacerts` solo como bootstrap, calcula la huella de la
raíz y la compara con `rootCaSha256` antes de fijar TLS.

La primera importación muestra servidor, huellas corta y completa y el texto:
“Compara estas huellas con las que muestra el panel. Si no coinciden, cancela”.
La confirmación guarda un ancla por servidor. Un cambio de cualquiera de las
dos huellas se rechaza sin diálogo; hay que quitar la conexión y crearla de
nuevo. La raíz se conserva en preferencias privadas y se usa como trust store
exclusivo de EST.

La app no contiene claves privadas, certificados, servidores ni tokens de
didev. `signerPublicKey` forma parte del sobre firmado; la seguridad del
despliegue depende de la firma Ed25519 que el panel entrega a cada perfil.

## Clave y charon

Cada conexión crea una clave EC P-256 no exportable en AndroidKeyStore e intenta
StrongBox cuando existe. El CSR PKCS#10 incluye CN y SAN DNS iguales a `cn` y
su `ContentSigner` delega en `java.security.Signature` con la clave del
keystore. El método Java que el JNI upstream ya invoca (`getUserKey`) usa
AndroidKeyStore para aliases `didev-vpn-*`; el camino KeyChain original queda
intacto para perfiles de la app base. `android_private_key.c` sigue siendo el
adaptador que firma desde JNI y no se cambia `libcharon`.

WorkManager consulta `/status` cada 12 horas con red, bloquea si
`minAppVersion` es superior, y usa `simplereenroll` para certificados próximos
a caducar. La ronda EAP usuario/contraseña sigue desactivada.

## Tests y límites de esta entrega

Los tests unitarios nuevos cubren firma, huellas, versión y el rechazo de
anclas cambiadas. Los casos de primera importación confirmada/cancelada y QR
con raíz incorrecta deben ejecutarse como instrumentados porque requieren
`Context`, TLS y UI; quedan descritos abajo para un dispositivo real.

## Pruebas manuales en móvil real

1. Instalar un build sin firma de distribución, abrir la app y comprobar que
   convive con la app oficial por `applicationId es.didev.vpn`.
2. Escanear un QR válido, comparar ambas huellas, cancelar y verificar que no
   aparece conexión ni ancla; repetir y confirmar, comprobando que se genera
   clave AndroidKeyStore/StrongBox cuando está disponible.
3. Importar el mismo servidor con otra clave de firma o raíz: debe mostrar
   “la identidad del panel ha cambiado”; quitar y volver a añadir debe permitir
   el nuevo ancla.
4. Escanear un QR cuyo `/cacerts` no coincide con `rootCaSha256`: debe
   rechazarse antes de la confirmación.
5. Importar un `.didevvpn` `full`, conectar y verificar AAA `aaaId`, propuestas,
   full/split tunnel, IP y caducidad en la pantalla de estado.
6. Revocar o renovar el certificado en el panel, esperar la tarea o ejecutarla
   desde adb/WorkManager, comprobar `/status`, nueva clave y reconexión solo si
   la VPN estaba activa.
7. Publicar una `minAppVersion` superior y confirmar que alta y renovación
   quedan bloqueadas con aviso de actualización.
8. Quitar una conexión y confirmar que deja de aparecer, se borra el ancla y
   no se puede reutilizar el certificado anterior desde la app.

## Rebase sobre strongSwan

Base importada: commit `c5652d46231f9513c5e84ac4aa2e2e109db15624`.
Ficheros upstream modificados por esta bifurcación:

- `app/build.gradle`
- `app/src/main/AndroidManifest.xml`
- `app/src/main/res/values/strings.xml`
- `app/src/main/res/drawable/ic_didev_launcher.xml`
- `app/src/main/java/org/strongswan/android/logic/StrongSwanApplication.java`
- `app/src/main/java/org/strongswan/android/logic/CharonVpnService.java`
- `app/src/main/jni/libandroidbridge/backend/android_private_key.c` no se modifica; se conserva como puente upstream

Todo lo demás bajo `org/strongswan/android/didev` y `build.ps1` es código
añadido didev. Al rebasar, resolver primero cambios en esos ficheros y revisar
las firmas de JNI de `CharonVpnService`.
