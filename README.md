# Job Runner — React · Spring Boot · AWS Fargate

Full-stack job queue demo: a React UI submits jobs that Spring Boot writes to **DynamoDB** and enqueues on **SQS**; a worker loop transitions each job `PENDING → PROCESSING → COMPLETED`. The ECS Fargate service scales to zero when idle — a **Start Backend** button triggers a Lambda + API Gateway to spin it up (~30–60 s) — keeping the demo free between sessions. Two runtime modes let the same binary run locally without any AWS dependencies.

**[→ Portfolio demo](https://bganguly.github.io/#job_runner)**

---

## Using the App

> **First visit — "Start Backend" button**
>
> The ECS Fargate service is scaled to zero when idle to avoid paying ~$7/month for an always-on container. If you land on the page and the backend is down, a **Start Backend** button appears. Click it — the UI spins up the service via Lambda + API Gateway, polls until the ALB health check passes (~30–60 s), then reloads automatically. Once the backend is running you can submit jobs normally. The service auto-stops after 10 minutes of inactivity.

1. Click **Create Job** to submit a job — the Spring Boot API writes to DynamoDB and enqueues via SQS.
2. The UI polls `GET /jobs/{jobId}` and shows the state transition: `PENDING → PROCESSING → COMPLETED`.
3. In local mode (`LOCAL_MEMORY`) jobs complete instantly in-memory; in AWS mode (`AWS_DYNAMODB_SQS`) processing runs asynchronously via the SQS consumer.

---

| Component | Implementation |
|---|---|
| **Frontend** | React 18 + TypeScript + Vite; polls `GET /jobs/{id}` on a 1 s interval until terminal state |
| **Backend** | Spring Boot 3 on ECS Fargate (:8080); two runtime modes: `LOCAL_MEMORY` (dev) and `AWS_DYNAMODB_SQS` (prod) |
| **Job store** | DynamoDB `jobs` table keyed on `jobId`; `status` attribute drives the UI state machine |
| **Async queue** | SQS standard queue + dead-letter queue; Spring Boot worker polls and transitions `PROCESSING → COMPLETED` |
| **Scale-to-zero** | ECS desired count = 0 at rest; Lambda + API Gateway re-scales on demand and polls ALB health before returning |
| **Frontend hosting** | S3 static hosting behind CloudFront (HTTPS); Vite build with `VITE_API_BASE_URL` injected at deploy time |
| **Image build** | AWS CodeBuild builds and pushes the Spring Boot image to ECR from a source zip — no local Docker needed |
| **IaC** | CloudFormation — VPC, DynamoDB, SQS, ECS cluster + Fargate task, ALB, IAM, CloudWatch logs |

---

## Live Service

| | URL |
|---|---|
| **App** | https://{frontend-cloudfront-domain} |
| **API** | https://{api-cloudfront-domain} |

## Screenshots

Main UI:

![Spring Boot Job Runner UI](assets/screenshots/app-ui.png)

---

## Architecture

### Job submission flow — step by step

1. **Browser → React UI** — user clicks Create Job; the UI POSTs `{ "message": "..." }` to the CloudFront-fronted API URL.
2. **CloudFront → ALB → Spring Boot** — the request reaches the ECS Fargate task; Spring Boot writes a new job record to DynamoDB (`status: PENDING`) and enqueues a message to SQS, returning `202 { jobId, status }`.
3. **SQS worker loop** — the in-process Spring Boot worker polls the SQS queue; on receipt it updates the DynamoDB record to `PROCESSING`, executes the job, then updates to `COMPLETED`.
4. **UI polling** — the React UI calls `GET /jobs/{jobId}` on a 1 s interval; when it receives `COMPLETED`, polling stops and the final state is displayed.

```mermaid
sequenceDiagram
    participant B as Browser
    participant CF as CloudFront
    participant LB as ALB
    participant SB as Spring Boot (ECS)
    participant DY as DynamoDB
    participant SQ as SQS

    B->>CF: POST /jobs { message }
    CF->>LB: forward request
    LB->>SB: POST /jobs
    SB->>DY: write job (PENDING)
    SB->>SQ: enqueue job message
    SB-->>B: 202 { jobId, status: PENDING }

    Note over SB: worker poll loop
    SB->>SQ: receive message
    SB->>DY: update status (PROCESSING)
    SB->>DY: update status (COMPLETED)

    loop every 1 s
        B->>CF: GET /jobs/{jobId}
        CF->>SB: forward
        SB->>DY: read job status
        DY-->>B: { status }
    end
```

### Key design decisions

| Concern | Approach |
|:--|:--|
| **Scale-to-zero** | ECS desired count = 0 at rest; Lambda reads the CloudFront domain from SSM and calls `update-service --desired-count 1`, then polls ALB target health — the browser only gets a response once the container is healthy |
| **Two runtime modes** | `LOCAL_MEMORY` wires an in-memory store + synchronous processor for local dev with no AWS deps; `AWS_DYNAMODB_SQS` is the production path — the same Spring Boot binary, toggled via env vars |
| **CloudFront in front of ALB** | Avoids browser mixed-content blocking (HTTPS frontend → HTTPS API) and keeps the public API URL stable across backend redeployments |
| **CodeBuild for image build** | Source zip uploaded to S3 triggers CodeBuild — no local Docker daemon needed; `deploy.sh` works from any machine |
| **SQS dead-letter queue** | Jobs that fail processing exceed the retry limit are moved to a DLQ for inspection without blocking the main queue |
| **DynamoDB key design** | Jobs keyed on UUID `jobId`; `status` is a plain string attribute — no secondary indexes needed for the single-item polling path |

---

## Running

Backend image build/push runs in AWS CodeBuild — local Docker is not required.

```bash
./artifacts/aws/deploy.sh <stack-name> <region> <account-id> <vpc-id> <subnet-a> <subnet-b>
./artifacts/aws/deploy-frontend.sh <frontend-stack-name> <region> <bucket-name> <api-url> frontend
```

`deploy.sh` uploads a source zip to S3, triggers CodeBuild to build and push the Spring Boot image to ECR, then deploys `infra.yaml` (CloudFormation: VPC, DynamoDB, SQS, ECS Fargate, ALB).
`deploy-frontend.sh` deploys `frontend-infra.yaml` (S3 + CloudFront), builds the React app with `VITE_API_BASE_URL` set to `ApiHttpsUrl`, uploads `dist/` to S3, and invalidates the CloudFront cache.

---

## Architecture / Topology

```
Browser ──HTTPS──► CloudFront (CDN) ──► S3 (Vite dist)
                        │
                        └──HTTPS──► ALB ──► ECS Fargate: Spring Boot (:8080)
                                                │                │
                                                ▼                ▼
                                           DynamoDB         SQS Queue
                                          (jobs table)     (job msgs)
                               ▲──────── CloudFormation (IaC) ──────────▲
```

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              AWS Account                                │
│                                                                         │
│   ECR                                                                   │
│   ┌──────────────────┐                                                  │
│   │  backend image   │◄── CodeBuild (build + push from S3 source zip)  │
│   └──────────────────┘                                                  │
│           │ image pull                  CloudFormation (IaC)           │
│           ▼                             manages all resources below     │
│   ┌─────────────────────────────────────────────────────────────┐       │
│   │                   VPC (public subnets)                      │       │
│   │                                                             │       │
│   │   ALB ──► ECS Fargate task                                  │       │
│   │   ┌──────────────────────────────────────────────────┐      │       │
│   │   │ Spring Boot (:8080)                              │      │       │
│   │   │ • POST /jobs  → DynamoDB write + SQS enqueue     │      │       │
│   │   │ • GET  /jobs/{id} → DynamoDB read                │      │       │
│   │   │ • worker: SQS poll → PROCESSING → COMPLETED      │      │       │
│   │   └────────────────────┬───────────────┬─────────────┘      │       │
│   └────────────────────────┼───────────────┼────────────────────┘       │
│                            │               │                             │
│                 ┌──────────▼───────┐  ┌────▼─────────┐                 │
│                 │   DynamoDB       │  │  SQS Queue   │                 │
│                 │  (jobs table)    │  │  (job msgs)  │                 │
│                 │  PENDING         │  └──────────────┘                 │
│                 │  PROCESSING      │                                    │
│                 │  COMPLETED       │                                    │
│                 └──────────────────┘                                    │
│                                                                         │
│   CloudFront + S3 (frontend)                                           │
│   ┌────────────────────────────────────────────────────┐               │
│   │ CloudFront (HTTPS) ──► S3 bucket (Vite dist)       │               │
│   └────────────────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────┘

Deploy flow
───────────
local machine
  └─ artifacts/aws/deploy.sh
       ├─ upload source zip → S3
       ├─ trigger CodeBuild → build + push image → ECR
       └─ deploy infra.yaml (CloudFormation)
            ├─ VPC / subnets / security groups
            ├─ DynamoDB table
            ├─ SQS queue + dead-letter queue
            ├─ ECS cluster + Fargate task + ALB
            └─ IAM roles + CloudWatch logs

  └─ artifacts/aws/deploy-frontend.sh
       ├─ deploy frontend-infra.yaml (CloudFormation)
       │    ├─ S3 bucket (static hosting)
       │    └─ CloudFront distribution
       ├─ build React app (VITE_API_BASE_URL → ApiHttpsUrl)
       ├─ upload dist/ → S3
       └─ invalidate CloudFront cache
```

## API

- `POST /jobs` -> accepts `{ "message": "..." }`, returns `202` with `{ jobId, status }`
- `GET /jobs/{jobId}` -> returns current job state
- `GET /jobs/mode` -> returns backend mode (`LOCAL_MEMORY` or `AWS_DYNAMODB_SQS`)

## Project structure

- `frontend`: React + TypeScript + Vite
- `backend`: Spring Boot API, queue worker loop, DynamoDB/SQS integration
- `artifacts/aws`: deploy artifacts for ECS Fargate + DynamoDB + SQS

## AWS mode configuration

Set these environment variables for the backend container/task:

- `AWS_JOBS_ENABLED=true`
- `AWS_JOBS_TABLE_NAME=<dynamodb-table-name>`
- `AWS_JOBS_QUEUE_URL=<sqs-queue-url>`
- `AWS_JOBS_QUEUE_POLLING_ENABLED=true`

When `AWS_JOBS_ENABLED=true`, create/read operations use DynamoDB and async processing uses SQS.

## AWS artifacts included

- `backend/Dockerfile`: container image build for ECS/Fargate
- `artifacts/aws/infra.yaml`: CloudFormation stack for DynamoDB, SQS, ECS, ALB, IAM, logs
- `artifacts/aws/task-definition.json`: task definition template
- `artifacts/aws/frontend-infra.yaml`: CloudFormation stack for S3 + CloudFront frontend hosting
- `artifacts/aws/deploy.sh`: backend deploy helper (builds image in AWS CodeBuild, then deploys API stack)
- `artifacts/aws/deploy-frontend.sh`: helper script to deploy frontend infra and static assets

## Deploy backend (ECS Fargate + ALB)

```bash
chmod +x artifacts/aws/deploy.sh
./artifacts/aws/deploy.sh <stack-name> <region> <account-id> <vpc-id> <subnet-a> <subnet-b>
```

The backend deploy script uses AWS CodeBuild for image build/push, so local Docker is not required.

This outputs both API URLs:

- `ApiBaseUrl`: ALB HTTP URL (`http://...elb.amazonaws.com`)
- `ApiHttpsUrl`: CloudFront HTTPS URL (`https://...cloudfront.net`)

Use `ApiHttpsUrl` for browser-based frontend deployments to avoid mixed-content blocking.

## AWS deployment gotchas

- Run deploy commands from repo root so relative paths like `artifacts/aws/infra.yaml` resolve correctly.
- If frontend is on HTTPS and API is HTTP, the browser blocks requests (`Failed to fetch`) because of mixed content.
- Use stack output `ApiHttpsUrl` as `VITE_API_BASE_URL` when deploying frontend.
- First-time ECS service stabilization can take 15-30 minutes while tasks register with ALB and old targets drain.
- Expected job transition (`PROCESSING` -> `COMPLETED`) is a few seconds after warm-up; if it drifts much higher, redeploy latest backend image and verify scheduler concurrency settings.
- `CREATE_IN_PROGRESS` on CloudFormation can continue even when ECS already shows `runningCount=desiredCount`.
- If ECS events show `CannotPullContainerError ... image ...:latest not found`, your image was not pushed to ECR yet.

Quick checks:

```bash
aws cloudformation describe-stacks --stack-name <stack-name> --region <region> --query "Stacks[0].StackStatus" --output text
aws ecs describe-services --cluster <ecs-cluster-name> --services <service-name> --region <region> --query "services[0].[runningCount,desiredCount,deployments[0].rolloutState]" --output text
```

When image is missing in ECR:

1. Re-run CodeBuild image build and wait for `SUCCEEDED`.
2. Force ECS service to redeploy:

```bash
aws ecs update-service --cluster <ecs-cluster-name> --service <service-name> --force-new-deployment --region <region>
```

Rate limit note:

- If CodeBuild fails with Docker Hub `429 Too Many Requests`, use AWS Public ECR mirror base images in `backend/Dockerfile` (already configured in this repo).

## First-time backend deploy checklist

Use this checklist for the first deployment in a new AWS account/region.

1. Confirm AWS auth and region.
2. Create/select a VPC and two public subnets in different AZs.
3. Ensure Internet Gateway and route table allow `0.0.0.0/0` egress.
4. Ensure both subnets have auto-assign public IP enabled.
5. Create S3 bucket for source zip uploads.
6. Create ECR repo `aws-springboot-jobs`.
7. Create IAM role for CodeBuild and attach permissions for S3/ECR/Logs.
8. Upload source zip (includes `buildspec.yml` and backend source).
9. Run CodeBuild and wait for image push success.
10. Deploy CloudFormation backend stack from `artifacts/aws/infra.yaml`.
11. If ECS service is stuck, check target health and ECS service events.
12. Retrieve `ApiBaseUrl` from stack outputs and run smoke test.

Helpful commands:

```bash
aws cloudformation describe-stacks --stack-name <backend-stack-name> --region <region> --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text
aws cloudformation describe-stacks --stack-name <backend-stack-name> --region <region> --query "Stacks[0].Outputs[?OutputKey=='ApiHttpsUrl'].OutputValue" --output text
npm run smoke:aws -- <api-base-url> <frontend-url>
```

## Deploy frontend (S3 + CloudFront)

```bash
chmod +x artifacts/aws/deploy-frontend.sh
./artifacts/aws/deploy-frontend.sh \
	<frontend-stack-name> \
	<region> \
	<globally-unique-site-bucket-name> \
	<api-base-url-from-backend-stack> \
	frontend
```

The frontend script will:

- Deploy/update S3 + CloudFront infrastructure.
- Build the React app with `VITE_API_BASE_URL` set to your backend ALB URL.
- Upload `frontend/dist` to S3.
- Invalidate CloudFront cache.

Use the `FrontendUrl` stack output as your public UI URL.

## Smoke tests

AWS hosted check (API + CloudFront frontend):

```bash
npm run smoke:aws -- <api-base-url> <frontend-url>
```

Example:

```bash
npm run smoke:aws -- http://my-api-alb.amazonaws.com https://d123456abcdef.cloudfront.net
```
