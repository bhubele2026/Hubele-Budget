// (AI-4b) The seam every outbound text goes through. A provider turns one
// message into one provider message id; it knows nothing about households,
// consent or caps — sendSms() (send.ts) owns those.

export type SmsProviderName = "twilio" | "console" | "fake";

export interface SmsMessage {
  to: string;
  body: string;
  /** Stable per logical message. Providers that support it forward it; sendSms() dedupes on it regardless. */
  idempotencyKey: string;
  /** Where the provider should POST delivery status for this one message. */
  statusCallbackUrl?: string;
}

export interface SmsProvider {
  readonly name: SmsProviderName;
  send(msg: SmsMessage): Promise<{ providerId: string }>;
}
