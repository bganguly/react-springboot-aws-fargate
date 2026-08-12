import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import BackToPortfolio from "./components/BackToPortfolio";

type JobStatus = "PENDING" | "PROCESSING" | "COMPLETED";

interface JobResponse {
  jobId: string;
  status: JobStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
  processingAt?: string;
  processedAt?: string;
  result?: string;
}

type ServiceStatus = "UNKNOWN" | "STOPPED" | "STARTING" | "RUNNING";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const adminApiUrl = (import.meta.env.VITE_ADMIN_API_URL ?? "").replace(/\/$/, "");

async function createJob(message: string): Promise<{ jobId: string; status: JobStatus }> {
  const response = await fetch(`${apiBaseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  if (!response.ok) throw new Error(`Create job failed with status ${response.status}`);
  return (await response.json()) as { jobId: string; status: JobStatus };
}

async function fetchJob(jobId: string): Promise<JobResponse> {
  const response = await fetch(`${apiBaseUrl}/jobs/${jobId}`);
  if (!response.ok) throw new Error(`Fetch job failed with status ${response.status}`);
  return (await response.json()) as JobResponse;
}

async function fetchServiceStatus(): Promise<ServiceStatus> {
  const response = await fetch(`${adminApiUrl}/service/status`);
  if (!response.ok) throw new Error(`Status check failed: ${response.status}`);
  const payload = (await response.json()) as { status: ServiceStatus };
  return payload.status;
}

async function startService(): Promise<void> {
  const response = await fetch(`${adminApiUrl}/service/start`, { method: "POST" });
  if (!response.ok) throw new Error(`Start failed: ${response.status}`);
}

export default function App() {
  const [message, setMessage] = useState("Build me a Spring Boot sample");
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>("UNKNOWN");
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const isConfigured = useMemo(() => Boolean(apiBaseUrl), []);
  const hasAdminUrl = useMemo(() => Boolean(adminApiUrl), []);
  const serviceReady = !hasAdminUrl || serviceStatus === "RUNNING";

  function stopPoll() {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function formatTimestampWithMs(iso?: string): string {
    if (!iso) return "-";
    const date = new Date(iso);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = String(date.getFullYear());
    const hours24 = date.getHours();
    const hours12 = hours24 % 12 || 12;
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const period = hours24 >= 12 ? "pm" : "am";
    return `${month}/${day}/${year} ${hours12}:${minutes}:${seconds}.${ms} ${period}`;
  }

  useEffect(() => {
    if (!hasAdminUrl) return;
    let cancelled = false;
    fetchServiceStatus()
      .then((s) => {
        if (cancelled) return;
        setServiceStatus(s);
        if (s === "STARTING") startBackendPoll();
      })
      .catch(() => { });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAdminUrl]);


  useEffect(() => {
    if (!currentJobId) return;
    let cancelled = false;
    const pollInterval = window.setInterval(async () => {
      try {
        const data = await fetchJob(currentJobId);
        if (!cancelled) {
          setJob(data);
          if (data.status === "COMPLETED") window.clearInterval(pollInterval);
        }
      } catch (pollError) {
        if (!cancelled) setError((pollError as Error).message);
      }
    }, 2000);
    return () => { cancelled = true; window.clearInterval(pollInterval); };
  }, [currentJobId]);

  useEffect(() => stopPoll, []);

  function startBackendPoll() {
    stopPoll();
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/jobs/mode`);
        if (res.ok) {
          stopPoll();
          window.location.reload();
        }
      } catch {
        // still not reachable, keep polling
      }
    }, 5000);
  }

  async function onClickStart() {
    setStartError(null);
    setServiceStatus("STARTING");
    try {
      await startService();
    } catch (err) {
      setStartError((err as Error).message);
      setServiceStatus("STOPPED");
      return;
    }
    startBackendPoll();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isConfigured) {
      setError("Set VITE_API_BASE_URL before submitting jobs");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    setJob(null);
    try {
      const created = await createJob(message.trim());
      setCurrentJobId(created.jobId);
      const initialJob = await fetchJob(created.jobId);
      setJob(initialJob);
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="page">
      <BackToPortfolio />
      <main className="card">
        <h1>Spring Boot Job Runner</h1>
        <p>
          Submit work from React to Spring Boot on AWS Fargate with DynamoDB + SQS-backed async state updates.
        </p>

        {hasAdminUrl && serviceStatus === "STOPPED" && (
          <div className="service-banner">
            <p>Backend is scaled down to save cost.</p>
            <button type="button" onClick={onClickStart}>
              Start Backend
            </button>
            {startError && <p className="error">{startError}</p>}
          </div>
        )}

        {hasAdminUrl && serviceStatus === "STARTING" && (
          <div className="service-banner service-banner--starting">
            <span className="spinner" />
            <p>Starting pods&hellip; this takes about 30s.</p>
          </div>
        )}

        <form onSubmit={onSubmit} className="stack">
          <label htmlFor="message">Message</label>
          <input
            id="message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Type work payload"
            required
            disabled={!serviceReady}
          />
          <button type="submit" disabled={isSubmitting || !message.trim() || !serviceReady}>
            {isSubmitting ? "Submitting..." : "Create Job"}
          </button>
        </form>

        {!isConfigured && (
          <p className="warning">VITE_API_BASE_URL is missing. Add it in frontend/.env.local.</p>
        )}

        {error && <p className="error">{error}</p>}

        {job && (
          <section className="job">
            <h2>Job Status</h2>
            <p><strong>ID:</strong> {job.jobId}</p>
            <p><strong>Status pending:</strong> {formatTimestampWithMs(job.createdAt)}</p>
            <p><strong>Status processing:</strong> {formatTimestampWithMs(job.processingAt)}</p>
            <p><strong>Status completed:</strong> {formatTimestampWithMs(job.processedAt)}</p>
            <p><strong>Message:</strong> {job.message}</p>
            {job.result && <p><strong>Result:</strong> {job.result}</p>}
            <p><strong>Updated:</strong> {new Date(job.updatedAt).toLocaleString()}</p>
          </section>
        )}
      </main>
    </div>
  );
}
