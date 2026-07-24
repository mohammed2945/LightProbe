package io.liveprobe.bridge;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** HTTP client constrained to the user-configured broker origin and fixed API paths. */
final class BrokerClient {
    private final String baseUrl;
    private final String serviceId;
    private final String agentId;
    private final String apiKey;
    private final String commitSha;
    private final String commitSource;
    private final String projectId;
    private final String environment;
    private final HttpClient client;

    BrokerClient(
            URI brokerUri,
            String serviceId,
            String apiKey,
            String commitSha,
            String commitSource,
            String projectId,
            String environment) {
        this.baseUrl = normalizedBase(brokerUri);
        this.serviceId = serviceId;
        this.agentId = UUID.randomUUID().toString();
        this.apiKey = apiKey;
        this.commitSha = commitSha;
        this.commitSource = commitSource;
        this.projectId = projectId;
        this.environment = environment;
        this.client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    Protocol.PollResponse poll(long version) throws IOException, InterruptedException {
        URI uri = URI.create(baseUrl + "/v1/services/" + pathSegment(serviceId) + "/probes?since=" + version);
        HttpRequest request = withAuth(HttpRequest.newBuilder(uri))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = client.send(
                request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200) {
            throw new IOException("broker poll returned HTTP " + response.statusCode());
        }
        return Protocol.parsePoll(response.body());
    }

    void ingest(String state, String detail, List<Map<String, Object>> events)
            throws IOException, InterruptedException {
        Map<String, Object> payload = Protocol.ingestPayload(
                serviceId, agentId, commitSha, commitSource, state, detail, events);
        HttpRequest request = withAuth(
                        HttpRequest.newBuilder(URI.create(baseUrl + "/v1/ingest")))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json; charset=utf-8")
                .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(payload), StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> response = client.send(
                request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 202) {
            throw new BrokerIngestException(response.statusCode());
        }
    }

    HttpRequest.Builder withAuth(HttpRequest.Builder builder) {
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("Authorization", "Bearer " + apiKey);
        }
        if (projectId != null && !projectId.isBlank()) {
            builder.header("LiveProbe-Project", projectId);
        }
        if (environment != null && !environment.isBlank()) {
            builder.header("LiveProbe-Environment", environment);
        }
        return builder;
    }

    private static String normalizedBase(URI uri) {
        if (uri == null || !uri.isAbsolute()
                || !("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                || uri.getHost() == null
                || uri.getRawQuery() != null
                || uri.getRawFragment() != null
                || uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("broker must be an absolute http(s) URL without query or user info");
        }
        String value = uri.toString();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private static String pathSegment(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }
}

final class BrokerIngestException extends IOException {
    private final int statusCode;

    BrokerIngestException(int statusCode) {
        super("broker ingest returned HTTP " + statusCode);
        this.statusCode = statusCode;
    }

    int statusCode() {
        return statusCode;
    }

    boolean isNonRetryable() {
        return statusCode == 400;
    }
}
