export interface AskOption {
  label: string;
  description?: string;
}

export interface AskArgs {
  question: string;
  options: AskOption[];
  multi?: boolean;
  allowOther?: boolean;
  timeoutSec?: number;
}

export interface ValidatedArgs {
  question: string;
  options: AskOption[];
}

export interface AskDetails {
  answered: boolean;
  selected: string[];
  other?: string;
  reason?: "timeout" | "dismissed" | "noui";
}

export interface ToolText {
  type: "text";
  text: string;
}

export interface AskResult {
  content: ToolText[];
  details: AskDetails;
}

export type DisplayTarget =
  | { kind: "option"; index: number }
  | { kind: "other" }
  | { kind: "done" };

export interface SelectPrompt {
  kind: "select";
  title: string;
  displays: string[];
}

export interface InputPrompt {
  kind: "input";
  title: string;
  placeholder: string;
}

export type Prompt = SelectPrompt | InputPrompt;

export type Step =
  | { kind: "prompt"; prompt: Prompt }
  | { kind: "result"; result: AskResult };

export type Reply =
  | { kind: "picked"; value: string }
  | { kind: "empty"; timedOut: boolean; aborted: boolean };

export const TIMEOUT_EPSILON_MS = 250;
export const MAX_TIMEOUT_SEC = 86400;
export const SINGLE_ATTEMPTS = 20;
export const MULTI_ATTEMPTS = 200;
