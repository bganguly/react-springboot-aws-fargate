package com.example.awsspringboot.service;

import com.example.awsspringboot.model.JobItem;
import com.example.awsspringboot.model.JobStatus;
import jakarta.annotation.PreDestroy;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest;
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest;
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest;
import software.amazon.awssdk.services.dynamodb.model.ScanRequest;
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.DeleteMessageRequest;
import software.amazon.awssdk.services.sqs.model.Message;
import software.amazon.awssdk.services.sqs.model.ReceiveMessageRequest;
import software.amazon.awssdk.services.sqs.model.SendMessageRequest;

@Service
public class JobService {
  private static final String FIELD_JOB_ID = "jobId";
  private static final String FIELD_MESSAGE = "message";
  private static final String FIELD_STATUS = "status";
  private static final String FIELD_CREATED_AT = "createdAt";
  private static final String FIELD_UPDATED_AT = "updatedAt";
  private static final String FIELD_PROCESSING_AT = "processingAt";
  private static final String FIELD_PROCESSED_AT = "processedAt";
  private static final String FIELD_RESULT = "result";
  private static final String FIELD_CLIENT_ID = "clientId";
  private static final String FIELD_REMOTE_IP = "remoteIp";
  private static final String FIELD_CITY = "city";
  private static final String FIELD_COUNTRY = "country";
  private static final String FIELD_USER_AGENT = "userAgent";

  private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(2))
      .build();
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private final ConcurrentMap<String, JobItem> jobs = new ConcurrentHashMap<>();
  private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
  private final boolean awsEnabled;
  private final boolean queuePollingEnabled;
  private final String tableName;
  private final String queueUrl;
  private final DynamoDbClient dynamoDbClient;
  private final SqsClient sqsClient;

  public JobService(
      @Value("${aws.jobs.enabled:false}") boolean awsEnabled,
      @Value("${aws.jobs.queuePollingEnabled:true}") boolean queuePollingEnabled,
      @Value("${aws.jobs.tableName:jobs}") String tableName,
      @Value("${aws.jobs.queueUrl:}") String queueUrl) {
    this.awsEnabled = awsEnabled;
    this.queuePollingEnabled = queuePollingEnabled;
    this.tableName = tableName;
    this.queueUrl = queueUrl == null ? "" : queueUrl.trim();

    if (this.awsEnabled) {
      this.dynamoDbClient = DynamoDbClient.create();
      this.sqsClient = SqsClient.create();
      if (this.queuePollingEnabled) {
        scheduler.scheduleAtFixedRate(this::pollQueue, 500, 20_000, TimeUnit.MILLISECONDS);
      }
    } else {
      this.dynamoDbClient = null;
      this.sqsClient = null;
    }
  }

  public JobItem createJob(String message, String clientId, String remoteIp, String userAgent) {
    String now = Instant.now().toString();
    String jobId = UUID.randomUUID().toString();

    String[] geo = lookupGeo(remoteIp);

    JobItem item = new JobItem();
    item.setJobId(jobId);
    item.setMessage(message);
    item.setStatus(JobStatus.PENDING);
    item.setCreatedAt(now);
    item.setUpdatedAt(now);
    item.setClientId(clientId);
    item.setRemoteIp(remoteIp);
    item.setCity(geo[0]);
    item.setCountry(geo[1]);
    item.setUserAgent(userAgent);

    if (awsEnabled) {
      createAwsJob(item);
      return item;
    }

    jobs.put(jobId, item);

    scheduler.schedule(() -> markProcessing(jobId), 300, TimeUnit.MILLISECONDS);
    scheduler.schedule(() -> markCompleted(jobId), 1800, TimeUnit.MILLISECONDS);

    return item;
  }

  public Optional<JobItem> getJob(String jobId) {
    if (awsEnabled) {
      return getAwsJob(jobId);
    }

    return Optional.ofNullable(jobs.get(jobId));
  }

  public List<JobItem> listJobs(String clientId) {
    List<JobItem> result;
    if (awsEnabled) {
      result = new ArrayList<>();
      ScanRequest.Builder scanBuilder = ScanRequest.builder().tableName(tableName);
      if (clientId != null && !clientId.isBlank()) {
        scanBuilder
            .filterExpression("clientId = :cid")
            .expressionAttributeValues(Map.of(":cid", AttributeValue.builder().s(clientId).build()));
      }
      dynamoDbClient.scan(scanBuilder.build()).items().forEach(item -> {
        JobItem mapped = new JobItem();
        mapped.setJobId(readString(item, FIELD_JOB_ID));
        mapped.setMessage(readString(item, FIELD_MESSAGE));
        mapped.setStatus(JobStatus.valueOf(readString(item, FIELD_STATUS)));
        mapped.setCreatedAt(readString(item, FIELD_CREATED_AT));
        mapped.setUpdatedAt(readString(item, FIELD_UPDATED_AT));
        mapped.setProcessingAt(readString(item, FIELD_PROCESSING_AT));
        mapped.setProcessedAt(readString(item, FIELD_PROCESSED_AT));
        mapped.setResult(readString(item, FIELD_RESULT));
        mapped.setClientId(readString(item, FIELD_CLIENT_ID));
        mapped.setRemoteIp(readString(item, FIELD_REMOTE_IP));
        mapped.setCity(readString(item, FIELD_CITY));
        mapped.setCountry(readString(item, FIELD_COUNTRY));
        mapped.setUserAgent(readString(item, FIELD_USER_AGENT));
        result.add(mapped);
      });
    } else {
      result = new ArrayList<>(jobs.values());
      if (clientId != null && !clientId.isBlank()) {
        result.removeIf(j -> !clientId.equals(j.getClientId()));
      }
    }
    result.sort(Comparator.comparing(JobItem::getCreatedAt, Comparator.nullsLast(Comparator.reverseOrder())));
    return result;
  }

  public void deleteJobsByClientId(String clientId) {
    if (clientId == null || clientId.isBlank()) return;
    if (awsEnabled) {
      ScanRequest scanRequest = ScanRequest.builder()
          .tableName(tableName)
          .filterExpression("clientId = :cid")
          .expressionAttributeValues(Map.of(":cid", AttributeValue.builder().s(clientId).build()))
          .projectionExpression(FIELD_JOB_ID)
          .build();
      dynamoDbClient.scan(scanRequest).items().forEach(item -> {
        String jobId = readString(item, FIELD_JOB_ID);
        if (jobId != null) {
          dynamoDbClient.deleteItem(DeleteItemRequest.builder()
              .tableName(tableName)
              .key(Map.of(FIELD_JOB_ID, AttributeValue.builder().s(jobId).build()))
              .build());
        }
      });
    } else {
      jobs.values().removeIf(j -> clientId.equals(j.getClientId()));
    }
  }

  public String getMode() {
    return awsEnabled ? "AWS_DYNAMODB_SQS" : "LOCAL_MEMORY";
  }

  private void markProcessing(String jobId) {
    jobs.computeIfPresent(jobId, (id, item) -> {
      String now = Instant.now().toString();
      item.setStatus(JobStatus.PROCESSING);
      item.setProcessingAt(now);
      item.setUpdatedAt(now);
      return item;
    });
  }

  private void markCompleted(String jobId) {
    jobs.computeIfPresent(jobId, (id, item) -> {
      String now = Instant.now().toString();
      item.setStatus(JobStatus.COMPLETED);
      item.setProcessedAt(now);
      item.setUpdatedAt(now);
      item.setResult("Processed message for job " + jobId);
      return item;
    });
  }

  private void createAwsJob(JobItem item) {
    assertAwsQueueConfigured();

    Map<String, AttributeValue> attributes = new HashMap<>();
    attributes.put(FIELD_JOB_ID, AttributeValue.builder().s(item.getJobId()).build());
    attributes.put(FIELD_MESSAGE, AttributeValue.builder().s(item.getMessage()).build());
    attributes.put(FIELD_STATUS, AttributeValue.builder().s(item.getStatus().name()).build());
    attributes.put(FIELD_CREATED_AT, AttributeValue.builder().s(item.getCreatedAt()).build());
    attributes.put(FIELD_UPDATED_AT, AttributeValue.builder().s(item.getUpdatedAt()).build());
    putIfNotBlank(attributes, FIELD_CLIENT_ID, item.getClientId());
    putIfNotBlank(attributes, FIELD_REMOTE_IP, item.getRemoteIp());
    putIfNotBlank(attributes, FIELD_CITY, item.getCity());
    putIfNotBlank(attributes, FIELD_COUNTRY, item.getCountry());
    putIfNotBlank(attributes, FIELD_USER_AGENT, item.getUserAgent());

    dynamoDbClient.putItem(PutItemRequest.builder().tableName(tableName).item(attributes).build());

    sqsClient.sendMessage(SendMessageRequest.builder()
        .queueUrl(queueUrl)
        .messageBody(item.getJobId())
        .build());
  }

  private Optional<JobItem> getAwsJob(String jobId) {
    GetItemRequest request = GetItemRequest.builder()
        .tableName(tableName)
        .key(Map.of(FIELD_JOB_ID, AttributeValue.builder().s(jobId).build()))
        .build();
    Map<String, AttributeValue> item = dynamoDbClient.getItem(request).item();
    if (item == null || item.isEmpty()) {
      return Optional.empty();
    }

    JobItem mapped = new JobItem();
    mapped.setJobId(readString(item, FIELD_JOB_ID));
    mapped.setMessage(readString(item, FIELD_MESSAGE));
    mapped.setStatus(JobStatus.valueOf(readString(item, FIELD_STATUS)));
    mapped.setCreatedAt(readString(item, FIELD_CREATED_AT));
    mapped.setUpdatedAt(readString(item, FIELD_UPDATED_AT));
    mapped.setProcessingAt(readString(item, FIELD_PROCESSING_AT));
    mapped.setProcessedAt(readString(item, FIELD_PROCESSED_AT));
    mapped.setResult(readString(item, FIELD_RESULT));
    return Optional.of(mapped);
  }

  private void pollQueue() {
    if (!awsEnabled || queueUrl.isEmpty()) {
      return;
    }

    ReceiveMessageRequest request = ReceiveMessageRequest.builder()
        .queueUrl(queueUrl)
        .maxNumberOfMessages(5)
        .waitTimeSeconds(20)
        .visibilityTimeout(20)
        .build();

    List<Message> messages = sqsClient.receiveMessage(request).messages();
    for (Message message : messages) {
      processAwsJob(message);
    }
  }

  private void processAwsJob(Message message) {
    String jobId = message.body() == null ? "" : message.body().trim();
    if (jobId.isEmpty()) {
      deleteMessage(message.receiptHandle());
      return;
    }

    String processingAt = Instant.now().toString();
    UpdateItemRequest processingRequest = UpdateItemRequest.builder()
        .tableName(tableName)
        .key(Map.of(FIELD_JOB_ID, AttributeValue.builder().s(jobId).build()))
        .updateExpression("SET #status = :status, #processingAt = :processingAt, #updatedAt = :updatedAt")
        .expressionAttributeNames(Map.of(
            "#status", FIELD_STATUS,
            "#processingAt", FIELD_PROCESSING_AT,
            "#updatedAt", FIELD_UPDATED_AT))
        .expressionAttributeValues(Map.of(
            ":status", AttributeValue.builder().s(JobStatus.PROCESSING.name()).build(),
            ":processingAt", AttributeValue.builder().s(processingAt).build(),
            ":updatedAt", AttributeValue.builder().s(processingAt).build()))
        .build();
    dynamoDbClient.updateItem(processingRequest);

    scheduler.schedule(() -> {
      String completedAt = Instant.now().toString();
      UpdateItemRequest completedRequest = UpdateItemRequest.builder()
          .tableName(tableName)
          .key(Map.of(FIELD_JOB_ID, AttributeValue.builder().s(jobId).build()))
          .updateExpression(
              "SET #status = :status, #processedAt = :processedAt, #updatedAt = :updatedAt, #result = :result")
          .expressionAttributeNames(Map.of(
              "#status", FIELD_STATUS,
              "#processedAt", FIELD_PROCESSED_AT,
              "#updatedAt", FIELD_UPDATED_AT,
              "#result", FIELD_RESULT))
          .expressionAttributeValues(Map.of(
              ":status", AttributeValue.builder().s(JobStatus.COMPLETED.name()).build(),
              ":processedAt", AttributeValue.builder().s(completedAt).build(),
              ":updatedAt", AttributeValue.builder().s(completedAt).build(),
              ":result", AttributeValue.builder().s("Processed message for job " + jobId).build()))
          .build();
      dynamoDbClient.updateItem(completedRequest);
      deleteMessage(message.receiptHandle());
    }, 1800, TimeUnit.MILLISECONDS);
  }

  private void assertAwsQueueConfigured() {
    if (queueUrl.isEmpty()) {
      throw new IllegalStateException("AWS_JOBS_QUEUE_URL must be configured when AWS_JOBS_ENABLED=true");
    }
  }

  private void deleteMessage(String receiptHandle) {
    if (receiptHandle == null || receiptHandle.isBlank()) {
      return;
    }
    sqsClient.deleteMessage(DeleteMessageRequest.builder()
        .queueUrl(queueUrl)
        .receiptHandle(receiptHandle)
        .build());
  }

  private String[] lookupGeo(String ip) {
    if (ip == null || ip.isBlank() || ip.equals("127.0.0.1") || ip.startsWith("192.168.") || ip.startsWith("10.")) {
      return new String[]{null, null};
    }
    try {
      HttpRequest req = HttpRequest.newBuilder()
          .uri(URI.create("http://ip-api.com/json/" + ip + "?fields=city,country"))
          .timeout(Duration.ofSeconds(2))
          .GET()
          .build();
      HttpResponse<String> resp = HTTP_CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
      JsonNode node = MAPPER.readTree(resp.body());
      return new String[]{
          node.has("city") ? node.get("city").asText(null) : null,
          node.has("country") ? node.get("country").asText(null) : null
      };
    } catch (Exception e) {
      return new String[]{null, null};
    }
  }

  private void putIfNotBlank(Map<String, AttributeValue> map, String key, String value) {
    if (value != null && !value.isBlank()) {
      map.put(key, AttributeValue.builder().s(value).build());
    }
  }

  private String readString(Map<String, AttributeValue> item, String key) {
    AttributeValue value = item.get(key);
    if (value == null) {
      return null;
    }
    return value.s();
  }

  @PreDestroy
  public void shutdown() {
    scheduler.shutdownNow();
    if (dynamoDbClient != null) {
      dynamoDbClient.close();
    }
    if (sqsClient != null) {
      sqsClient.close();
    }
  }
}
