/**
 * Structured, stable error codes so the UI and tests can react deterministically
 * to failures. Errors are never "swallowed into success".
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "ELIGIBILITY"
  | "DUPLICATE"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_MISMATCH"
  | "INTERNAL"
  | "TOOL_ERROR";

export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  validation: (msg: string, details?: unknown) =>
    new AppError("VALIDATION_ERROR", msg, details),
  unauthorized: (msg = "You must be signed in.") =>
    new AppError("UNAUTHORIZED", msg),
  notFound: (what: string) => new AppError("NOT_FOUND", `${what} was not found.`),
  forbidden: (msg = "You are not allowed to perform this action.") =>
    new AppError("FORBIDDEN", msg),
  eligibility: (msg: string, details?: unknown) =>
    new AppError("ELIGIBILITY", msg, details),
  duplicate: (msg = "This action has already been submitted.") =>
    new AppError("DUPLICATE", msg),
  approvalRequired: (msg: string) => new AppError("APPROVAL_REQUIRED", msg),
  approvalNotFound: (id?: string) =>
    new AppError("APPROVAL_NOT_FOUND", `Approval request not found.`, { id }),
  approvalNotApproved: (id?: string) =>
    new AppError("APPROVAL_NOT_APPROVED", "The approval request was not approved.", {
      id,
    }),
  approvalExpired: (id?: string) =>
    new AppError("APPROVAL_EXPIRED", "The approval request has expired.", { id }),
  approvalMismatch: (msg: string) =>
    new AppError("APPROVAL_MISMATCH", msg),
  internal: (msg = "Internal error.") => new AppError("INTERNAL", msg),
  tool: (msg: string, details?: unknown) => new AppError("TOOL_ERROR", msg, details),
};
