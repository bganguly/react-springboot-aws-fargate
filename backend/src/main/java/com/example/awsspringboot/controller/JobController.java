package com.example.awsspringboot.controller;

import com.example.awsspringboot.dto.CreateJobRequest;
import com.example.awsspringboot.dto.CreateJobResponse;
import com.example.awsspringboot.model.JobItem;
import com.example.awsspringboot.service.JobService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/jobs")
public class JobController {
  private final JobService jobService;

  public JobController(JobService jobService) {
    this.jobService = jobService;
  }

  @PostMapping
  public ResponseEntity<?> createJob(@RequestBody CreateJobRequest request, HttpServletRequest httpRequest) {
    String message = request.getMessage() == null ? "" : request.getMessage().trim();

    if (message.isEmpty()) {
      return ResponseEntity.status(HttpStatus.BAD_REQUEST)
          .body(Map.of("error", "message is required"));
    }

    String remoteIp = extractClientIp(httpRequest);
    String userAgent = httpRequest.getHeader("User-Agent");
    JobItem item = jobService.createJob(message, request.getClientId(), remoteIp, userAgent);
    return ResponseEntity.status(HttpStatus.ACCEPTED)
        .body(new CreateJobResponse(item.getJobId(), item.getStatus()));
  }

  private String extractClientIp(HttpServletRequest request) {
    String xff = request.getHeader("X-Forwarded-For");
    if (xff != null && !xff.isBlank()) {
      return xff.split(",")[0].trim();
    }
    return request.getRemoteAddr();
  }

  @GetMapping
  public List<JobItem> listJobs(@RequestParam(required = false) String clientId) {
    return jobService.listJobs(clientId);
  }

  @GetMapping("/{jobId}")
  public ResponseEntity<?> getJob(@PathVariable String jobId) {
    return jobService.getJob(jobId)
        .<ResponseEntity<?>>map(ResponseEntity::ok)
        .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
            .body(Map.of("error", "Job not found")));
  }

  @DeleteMapping
  public ResponseEntity<Void> deleteJobs(@RequestParam(required = false) String clientId) {
    if (clientId == null || clientId.isBlank()) {
      return ResponseEntity.status(HttpStatus.BAD_REQUEST).build();
    }
    jobService.deleteJobsByClientId(clientId);
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/mode")
  public Map<String, String> getMode() {
    return Map.of("mode", jobService.getMode());
  }
}
