import type { SmsMessage, SmsProvider } from "./types";

// (AI-4b) Test double: records every send in `sentSms`. `failNext` makes the
// next send throw, to exercise the failure path.
export const sentSms: SmsMessage[] = [];

const state = { failNext: 0, counter: 0 };

export function _resetFakeSmsForTests(): void {
  sentSms.length = 0;
  state.failNext = 0;
  state.counter = 0;
}

export function _failNextFakeSms(times = 1): void {
  state.failNext = times;
}

export const fakeProvider: SmsProvider = {
  name: "fake",
  async send(msg: SmsMessage) {
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw new Error("fake provider: forced failure");
    }
    sentSms.push({ ...msg });
    state.counter += 1;
    return { providerId: `fake_${state.counter}` };
  },
};
