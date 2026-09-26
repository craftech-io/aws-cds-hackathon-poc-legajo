---
status: accepted
---

# El lector documental es una API externa; en la demo, un mock con contrato OpenAPI

Leer una factura, un packing list o un certificado de origen ya lo hace un producto existente en este mercado, y el CTO fijó que no es nuestro: no hacemos OCR, ni clasificación, ni extracción. Decidimos que el agente consuma un **lector documental** a través de un contrato OpenAPI 3.1 (`packages/reader-contract/openapi.yaml`) y que en la POC ese lector sea un **mock nuestro** (`ReaderMock`, Lambda con Function URL `AWS_IAM` y tabla propia) que reconoce nuestros PDF sintéticos por SHA-256 o por el id embebido en sus metadatos y devuelve la verdad de base sembrada: tipo, campos, confianza y observaciones. Lo desconocido es `UNRECOGNIZED` y va al despachante, que es quien clasifica.

## Considered options

- **Leer con un modelo multimodal nuestro**: contradice la restricción del CTO y nos convierte en competidores del producto que el mercado ya tiene.
- **Un target OpenAPI del Gateway de AgentCore apuntando al lector**: lindo en el diagrama, pero exige un proveedor de credenciales de AgentCore Identity para autenticar la salida y deja que el modelo decida cuándo leer; la lectura de un adjunto no es una decisión del agente.
- **Lectura determinista en el intake más una tool de consulta** (elegida): todo PDF que entra se lee siempre, sin modelo; el agente consulta la lectura con `read_document` por un target Lambda que usa el mismo cliente tipado.

## Consequences

- El modelo nunca ve el PDF ni sus metadatos; solo la lectura validada con zod contra el contrato. Una inyección escondida en un PDF no llega al agente.
- `npm run reader:contract` falla si los schemas del cliente y del mock divergen del YAML.
- Reemplazar el mock por un lector real es cambiar la URL y la autenticación del cliente; el resto del sistema no cambia.
- Las fallas del lector (latencia, 503, timeout) son configurables para probar reintentos, diferidos y el escalamiento `READER_UNAVAILABLE`.
