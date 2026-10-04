export interface RecalledFact {
  key: string;
  value: string;
  source: string;
}

export const SAKESAN_BOOKING_URL = "https://www.yelp.com/reservations/sakesan-sushi-and-robata-san-francisco-6";

// TODO: replace this demo adapter with the imported memory store's narrow query API.
// Do not load these facts into the system prompt or any specialist's context.
export async function recallFacts(query: string): Promise<RecalledFact[]> {
  const q = query.toLowerCase();
  const reservation = /reserv|book|japan|sakesan|restaurant|dinner/.test(q);
  const facts: { key: string; value: string; relevant: boolean }[] = [
    { key: "user.name", value: "Ty Doan", relevant: reservation || /name|identity|contact/.test(q) },
    { key: "user.phone", value: "4127088429", relevant: reservation || /phone|contact/.test(q) },
    { key: "user.email", value: "tdoan35@gmail.com", relevant: reservation || /email|contact/.test(q) },
    { key: "user.home", value: "1117 Ocean Ave, San Francisco, CA 94112", relevant: reservation || /home|live|place|address/.test(q) },
    { key: "restaurant.name", value: "Sakesan Sushi & Robata", relevant: reservation },
    { key: "restaurant.address", value: "1400 Ocean Ave, San Francisco, CA 94112", relevant: reservation },
    { key: "restaurant.phone", value: "(415) 347-7898", relevant: reservation },
    { key: "restaurant.bookingUrl", value: process.env.SAKESAN_BOOKING_URL || SAKESAN_BOOKING_URL, relevant: reservation },
    { key: "restaurant.hours", value: "4–10:30pm daily", relevant: reservation },
    { key: "reservation.partySize", value: "2", relevant: reservation || /party|size/.test(q) },
  ];
  return facts.filter((f) => f.relevant).map(({ key, value }) => ({ key, value, source: "Ty's supplied demo facts (stub)" }));
}
