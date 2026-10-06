import { randomUUID } from "node:crypto";

/** FIFO mutex: every action that touches the page runs through here, one at a time. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private held = false;

  get busy(): boolean {
    return this.held;
  }
  get depth(): number {
    return this.waiting;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting++;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    this.waiting--;
    this.held = true;
    try {
      return await fn();
    } finally {
      this.held = false;
      release();
    }
  }
}

export const lock = new Mutex();

export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobResult {
  status: "done" | "error";
  text: string;
  partial?: boolean;
  error?: string;
  message?: string;
  [k: string]: unknown;
}

export interface Job {
  id: string;
  prompt: string;
  status: JobStatus;
  /** Latest text seen so far; updated while the reply streams. */
  text: string;
  startedAt: number;
  result?: JobResult;
  finished: Promise<JobResult>;
}

const jobs = new Map<string, Job>();
let current: Job | null = null;

export function createJob(prompt: string, work: (job: Job) => Promise<JobResult>): Job {
  const job = { id: randomUUID().slice(0, 8), prompt, status: "queued", text: "", startedAt: Date.now() } as Job;
  job.finished = lock
    .run(async () => {
      job.status = "running";
      current = job;
      try {
        return await work(job);
      } finally {
        current = null;
      }
    })
    .then((r) => {
      job.result = r;
      job.status = r.status;
      return r;
    });
  jobs.set(job.id, job);
  // Keep the table small: drop finished jobs older than an hour.
  for (const [id, j] of jobs) if (j.result && Date.now() - j.startedAt > 3_600_000) jobs.delete(id);
  return job;
}

export const getJob = (id: string) => jobs.get(id);
export const currentJob = () => current;

/** Resolve with the job's result if it finishes within waitMs, otherwise null. */
export async function waitFor(job: Job, waitMs: number): Promise<JobResult | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)));
  try {
    return await Promise.race([job.finished, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
