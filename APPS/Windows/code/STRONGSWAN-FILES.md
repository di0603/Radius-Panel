# Ficheros derivados de strongSwan

La app de Windows comparte con el frontend Android de strongSwan la
integracion conceptual del perfil IKEv2/EAP-TLS, pero en esta rama no se
modifica `libcharon` ni se copia codigo del motor.

La bifurcacion especifica de cliente generico vive en estos ficheros de
`APPS/Windows/code`:

- `DidevVpn.Core/Profile/ProfileEnvelope.cs`
- `DidevVpn.Core/Profile/ProvisioningProfile.cs`
- `DidevVpn.Core/Profile/ProfileVerifier.cs`
- `DidevVpn.Core/Profile/Ed25519PublicKeySpki.cs`
- `DidevVpn.App/Orchestration/EnrollmentOrchestrator.cs`
- `DidevVpn.App/Orchestration/RenewalOrchestrator.cs`
- `DidevVpn.App/Services/ConnectionRecord.cs`
- `DidevVpn.App/TrayApplicationContext.cs`

La lista sirve como punto de revision al rebasar sobre nuevas versiones del
frontend de referencia. Las modificaciones de este cliente son de
aprovisionamiento, confianza TOFU y adaptacion al cliente VPN nativo de
Windows; el protocolo IKEv2 permanece fuera de este repositorio.
