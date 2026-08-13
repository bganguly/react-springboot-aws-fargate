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
  city?: string;
  country?: string;
  userAgent?: string;
}

type ServiceStatus = "UNKNOWN" | "STOPPED" | "STARTING" | "RUNNING";
type HistoryState = "loading" | "ok" | "api-error" | "unreachable";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const adminApiUrl = (import.meta.env.VITE_ADMIN_API_URL ?? "").replace(/\/$/, "");

function getClientId(): string {
  let id = localStorage.getItem("jobClientId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("jobClientId", id);
  }
  return id;
}
const CLIENT_ID = getClientId();

function parseUserAgent(ua?: string | null): string {
  if (!ua) return "Unknown";
  let browser = "Unknown";
  if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Chrome/")) browser = "Chrome";
  else if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Safari/")) browser = "Safari";
  let os = "Unknown";
  if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  else if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS X")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  return `${browser} / ${os}`;
}

async function createJob(message: string): Promise<{ jobId: string; status: JobStatus }> {
  const response = await fetch(`${apiBaseUrl}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, clientId: CLIENT_ID })
  });
  if (!response.ok) throw new Error(`Create job failed with status ${response.status}`);
  return (await response.json()) as { jobId: string; status: JobStatus };
}

async function fetchJobs(): Promise<JobResponse[]> {
  const response = await fetch(`${apiBaseUrl}/jobs?clientId=${encodeURIComponent(CLIENT_ID)}`);
  if (!response.ok) throw new Error(`Fetch jobs failed: ${response.status}`);
  return (await response.json()) as JobResponse[];
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
  const [jobHistory, setJobHistory] = useState<JobResponse[]>([]);
  const [historyState, setHistoryState] = useState<HistoryState>("loading");
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

  async function clearHistory() {
    try {
      await fetch(`${apiBaseUrl}/jobs?clientId=${encodeURIComponent(CLIENT_ID)}`, { method: "DELETE" });
    } catch {
      // proceed regardless
    }
    localStorage.setItem("jobClientId", crypto.randomUUID());
    window.location.reload();
  }

  function loadHistory() {
    setHistoryState("loading");
    fetchJobs()
      .then((jobs) => { setJobHistory(jobs); setHistoryState("ok"); })
      .catch((err: Error) => {
        setHistoryState(err.message === "Failed to fetch" ? "unreachable" : "api-error");
      });
  }

  useEffect(() => {
    if (!hasAdminUrl) {
      loadHistory();
      return;
    }
    let cancelled = false;
    fetchServiceStatus()
      .then((s) => {
        if (cancelled) return;
        setServiceStatus(s);
        if (s === "STARTING") startBackendPoll();
        if (s === "RUNNING") loadHistory();
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
          if (data.status === "COMPLETED") {
            window.clearInterval(pollInterval);
            loadHistory();
          }
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
      loadHistory();
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  const showHistoryContent = !hasAdminUrl || serviceStatus === "RUNNING";

  return (
    <div className="page">
      <BackToPortfolio />
      <main className="card">
        <h1>Spring Boot Job Runner</h1>
        <p>
          Submit work from React to Spring Boot on AWS Fargate with DynamoDB + SQS-backed async state updates.
        </p>

        {hasAdminUrl && serviceStatus === "UNKNOWN" && (
          <div className="service-banner service-banner--checking">
            <span className="spinner" />
            <p>Checking backend status&hellip;</p>
          </div>
        )}

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
            <p><strong>Message:</strong> {job.message}</p>
            <p><strong>ID:</strong> {job.jobId}</p>
            <p><strong>Submitted:</strong> {formatTimestampWithMs(job.createdAt)}</p>
            <p><strong>Processing:</strong> {job.processingAt ? formatTimestampWithMs(job.processingAt) : <span className="waiting">pending&hellip;</span>}</p>
            <p><strong>Completed:</strong> {job.processedAt ? formatTimestampWithMs(job.processedAt) : <span className="waiting">pending&hellip;</span>}</p>
            {job.result && <p><strong>Result:</strong> {job.result}</p>}
          </section>
        )}

        <section className="history">
          <h2>My Jobs</h2>
          {hasAdminUrl && serviceStatus === "STOPPED" && (
            <p className="history-meta">Start the backend above to load job history.</p>
          )}
          {showHistoryContent && historyState === "ok" && jobHistory.length === 0 && (
            <p className="history-meta">No prior jobs found.</p>
          )}
          {showHistoryContent && historyState === "ok" && jobHistory.length > 0 && (
            <div className="history-header-row">
              <p className="history-meta">{jobHistory.length} job{jobHistory.length !== 1 ? "s" : ""} from this browser.</p>
              <button type="button" className="btn-clear" onClick={clearHistory}>Delete All</button>
            </div>
          )}
          {showHistoryContent && historyState === "unreachable" && (
            <p className="history-meta">Job history unavailable.</p>
          )}
          {showHistoryContent && historyState === "api-error" && (
            <p className="history-meta error">Job history temporarily unavailable.</p>
          )}
          {showHistoryContent && historyState === "ok" && jobHistory.length > 0 && (
            <div className="history-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Message</th>
                    <th>Status</th>
                    <th>Location</th>
                    <th>Device</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {jobHistory.map((j) => (
                    <tr key={j.jobId}>
                      <td title={j.message}>{j.message.length > 40 ? j.message.slice(0, 40) + "…" : j.message}</td>
                      <td><span className={`status-badge status-badge--${j.status.toLowerCase()}`}>{j.status}</span></td>
                      <td>{[j.city, j.country].filter(Boolean).join(", ") || "—"}</td>
                      <td>{parseUserAgent(j.userAgent)}</td>
                      <td>{formatTimestampWithMs(j.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
