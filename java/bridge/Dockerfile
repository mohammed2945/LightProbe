# syntax=docker/dockerfile:1.7

FROM eclipse-temurin:17-jdk AS build

WORKDIR /workspace
COPY java/bridge/src/main/java/io/liveprobe/bridge src/main/java/io/liveprobe/bridge
RUN mkdir -p build/classes \
    && javac --release 17 --add-modules jdk.jdi \
      -d build/classes src/main/java/io/liveprobe/bridge/*.java \
    && jar --create --file build/liveprobe-bridge.jar \
      --main-class io.liveprobe.bridge.Main -C build/classes .

FROM eclipse-temurin:17-jdk

WORKDIR /app
COPY --from=build --chown=10001:10001 \
  /workspace/build/liveprobe-bridge.jar /app/liveprobe-bridge.jar

USER 10001:10001
ENTRYPOINT ["java", "--add-modules", "jdk.jdi", "-jar", "/app/liveprobe-bridge.jar"]
