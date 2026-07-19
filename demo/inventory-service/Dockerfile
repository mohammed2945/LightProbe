FROM maven:3.9.11-eclipse-temurin-17 AS build

WORKDIR /workspace
COPY pom.xml ./
RUN mvn --batch-mode --no-transfer-progress dependency:go-offline
COPY src ./src
RUN mvn --batch-mode --no-transfer-progress verify

FROM eclipse-temurin:17-jre

WORKDIR /app
COPY --from=build /workspace/target/inventory-service.jar /app/inventory-service.jar
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0555 /app/docker-entrypoint.sh

ENV BUG=on
ENV PORT=8080
ENV ENABLE_INTERNAL_JDWP=false
ENV INTERNAL_JDWP_PORT=5005

EXPOSE 8080
ENTRYPOINT ["/app/docker-entrypoint.sh"]
