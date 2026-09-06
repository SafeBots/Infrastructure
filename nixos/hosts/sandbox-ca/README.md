# Interceptor CA (provisioned at build)

Place `interceptor-ca.crt` here at build time (generated per sandbox/BUILD.md step 1).
The .crt is baked into BOTH the outer host (interceptor uses the matching .key,
kept only in the interceptor's StateDirectory) and the inner microVM's measured
trust store. The .key NEVER goes in the image — only the interceptor holds it at
runtime. This placeholder keeps the config path valid; the real cert is dropped
in by the build pipeline and is part of the measured closure.
