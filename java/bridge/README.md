# LiveProbe JVM bridge

The bridge is a Java 17+ zero-dependency JDI sidecar. Build and test it with:

```sh
make test
```

Start the target JVM with local-only JDWP and full debug information (`javac -g`):

```sh
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005 \
  -jar inventory-service.jar
```

Then run the sidecar:

```sh
java --add-modules jdk.jdi -jar build/liveprobe-bridge.jar \
  --service inventory-service \
  --attach 127.0.0.1:5005 \
  --broker http://127.0.0.1:7070
```

Bind JDWP to loopback unless the deployment has an equivalent private, authenticated network
boundary. Source line resolution requires `LineNumberTable` metadata, and local capture requires
`LocalVariableTable` metadata; compile target classes with `-g`.

Optional repeated `--redact-key` and `--redact-value` flags extend the serializer defaults.
`--hits-per-second` defaults to 10.
