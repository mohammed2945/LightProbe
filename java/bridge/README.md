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

Then run the sidecar with the same bearer key as the broker and the deployed
commit SHA:

```sh
export LIVEPROBE_API_KEY="your-shared-key"
export LIVEPROBE_PROJECT_ID="inventory-repo"
export LIVEPROBE_ENVIRONMENT="production"
java --add-modules jdk.jdi -jar build/liveprobe-bridge.jar \
  --service inventory-service \
  --attach 127.0.0.1:5005 \
  --broker http://127.0.0.1:7070 \
  --commit "$GIT_COMMIT"
```

The bridge exits before attaching when no valid 7-64 character hexadecimal
commit is available from `--commit`, `LIVEPROBE_COMMIT_SHA`, or `GIT_COMMIT`.
Project and environment routing use `--project` / `--environment` when
provided, then `LIVEPROBE_PROJECT_ID` / `LIVEPROBE_ENVIRONMENT`. A service
credential is accepted only in its issued project and environment.

Bind JDWP to loopback unless the deployment has an equivalent private, authenticated network
boundary. Source line resolution requires `LineNumberTable` metadata, and local capture requires
`LocalVariableTable` metadata; compile target classes with `-g`.

Optional repeated `--redact-key` and `--redact-value` flags extend the serializer defaults.
`--hits-per-second` defaults to 10.

Log probe definitions accept an optional camel-case `logLevel` field with
`debug`, `info`, `warn`, or `error`. The bridge emits the configured level with
each log event; definitions without `logLevel` remain compatible and default to
`info`.

The bridge advertises `expression-ast-v1` and evaluates broker-compiled
conditions, snapshot watches, log template segments, and metric expressions.
The portable AST is bounded and supports only fixed map/field/list access,
finite scalar arithmetic, comparisons, and strict boolean operators. It never
calls target methods, getters, constructors, reflection, or a language
evaluator. Legacy dot-path probe definitions remain supported.
Numeric expressions use finite IEEE-754 values and reject integer inputs or
results outside the safe integer range so behavior is identical across SDKs.

Snapshot probes may request bounded per-frame locals with
`includeStackLocals`, which defaults to `false`; `stackFrameLimit` defaults to
3 and is capped at 8. Frames without `LocalVariableTable` data remain visible
with an empty serialized variables object. Frame data uses the normal serializer
and redaction limits. The bridge advertises this support as `frame-locals-v1`.

Maven builds and verifies the publishable artifact with `mvn verify`. The
package coordinates are `io.liveprobe:liveprobe-bridge:0.2.0`; the first MVP
publishes to GitHub Packages.
