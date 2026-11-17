const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { createApp } = require("../lib/app");
const { processNotificationJobs } = require("../lib/commerce/service");
const { localInstant } = require("../lib/commerce/domain");
let server, base, staff, operator, guest, other, booking, customer, config;
const key = () => randomUUID();
const day = (offset) =>
  new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const input = {
  name: "Ana Ionescu",
  phone: "+40700123456",
  licensePlate: "IS 20 ANA",
  flight: "RO 701",
  arrival: day(3) + "T10:00",
  departure: day(5) + "T10:00",
};
async function identity(email, role) {
  const auth = getAuth();
  let user;
  if (email) {
    user = await auth.createUser({ email, password: "Local-Only-123456!" });
    if (role) {
      await auth.setCustomUserClaims(user.uid, { role });
      await getFirestore()
        .doc(`staffAccess/${user.uid}`)
        .set({ role, enabled: true });
    }
  }
  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:${email ? "signInWithPassword" : "signUp"}?key=emulator`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        email
          ? { email, password: "Local-Only-123456!", returnSecureToken: true }
          : { returnSecureToken: true },
      ),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  return { uid: body.localId, token: body.idToken };
}
async function call(method, path, user, body, idem = key()) {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { Authorization: "Bearer " + user.token } : {}),
      "Idempotency-Key": idem,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function action(b, name, extra = {}, idem = key()) {
  return call(
    "POST",
    `/v1/admin/bookings/${b.id}/${name}`,
    staff,
    { expectedRevision: b.revision, ...extra },
    idem,
  );
}
before(async () => {
  if (
    !process.env.FIRESTORE_EMULATOR_HOST ||
    !process.env.FIREBASE_AUTH_EMULATOR_HOST
  )
    throw Error("Emulators required");
  process.env.GCLOUD_PROJECT = "demo-parcare-iasi";
  initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-parcare-iasi/databases/(default)/documents`,
    { method: "DELETE" },
  );
  await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/demo-parcare-iasi/accounts`,
    { method: "DELETE" },
  );
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  staff = await identity("admin-commerce@example.com", "admin");
  operator = await identity("operator-commerce@example.com", "operator");
  guest = await identity();
  other = await identity();
  for (const person of [guest, other])
    assert.equal(
      (
        await call("POST", "/v1/guest/session", person, {
          email: "same-contact@example.com",
          phone: "0700123456",
        })
      ).status,
      200,
    );
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});
test("settings are administrator-only, revisioned, validated and idempotent; DST is explicit", async () => {
  assert.equal((await call("GET", "/v1/config")).body.config.configured, false);
  const body = {
    expectedRevision: 0,
    dailyRateBani: 3000,
    requestsEnabled: true,
    loyaltyEnabled: true,
    pointsPerDay: 10,
    benefitThreshold: 20,
    benefitPercent: 10,
    arrivalReminderMinutes: 1440,
    departureReminderMinutes: 30,
  };
  assert.equal(
    (await call("PUT", "/v1/admin/config", operator, body)).status,
    403,
  );
  assert.equal(
    (await call("PUT", "/v1/admin/config", guest, body)).status,
    403,
  );
  const idem = key(),
    saved = await call("PUT", "/v1/admin/config", staff, body, idem);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  config = saved.body.config;
  assert.deepEqual(
    (await call("PUT", "/v1/admin/config", staff, body, idem)).body.config,
    config,
  );
  assert.equal(
    (await call("PUT", "/v1/admin/config", staff, body)).status,
    409,
  );
  assert.throws(() => localInstant("2027-03-28T03:30"));
  assert.throws(() => localInstant("2027-10-31T03:30"));
  assert.throws(() => localInstant("2027-02-30T10:00"));
});
test("guest request has server price, no points or confirmation, no identity takeover and safe retry", async () => {
  const q = await call("POST", "/v1/quotes", guest, {
    arrival: input.arrival,
    departure: input.departure,
    applyBenefit: false,
  });
  assert.equal(q.status, 200);
  assert.equal(q.body.quote.totalBani, 6000);
  const payload = {
    ...input,
    applyBenefit: false,
    configRevision: q.body.quote.configRevision,
    benefitRevision: q.body.quote.benefitRevision,
    expiresAt: q.body.quote.expiresAt,
  };
  assert.equal(
    (
      await call("POST", "/v1/bookings/requests", guest, {
        ...payload,
        paymentStatus: "paid_online",
      })
    ).status,
    400,
  );
  const idem = key(),
    created = await call("POST", "/v1/bookings/requests", guest, payload, idem);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  booking = created.body.booking;
  customer = created.body.loyalty;
  assert.equal(booking.bookingStatus, "requested");
  assert.equal(booking.paymentStatus, "unpaid");
  assert.equal(customer.points, 0);
  assert.equal(customer.reservationCount, 0);
  assert.deepEqual(
    (await call("POST", "/v1/bookings/requests", guest, payload, idem)).body,
    created.body,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/v1/bookings/requests",
        guest,
        { ...payload, name: "Different name" },
        idem,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call("GET", `/v1/bookings/${booking.id}`, other)).status,
    404,
  );
  assert.equal(
    (await call("GET", "/v1/bookings?tab=upcoming", other)).body.items.length,
    0,
  );
  assert.equal(
    (
      await call("POST", `/v1/admin/bookings/${booking.id}/confirm`, guest, {
        expectedRevision: 1,
      })
    ).status,
    403,
  );
});
test("staff confirmation, revision conflicts and payment award points exactly once", async () => {
  const confirmed = await action(booking, "confirm");
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  booking = confirmed.body.booking;
  assert.equal(
    (await action({ ...booking, revision: 1 }, "arrive")).status,
    409,
  );
  assert.equal((await action(booking, "depart")).status, 409);
  const idem = key(),
    results = await Promise.all([
      action(booking, "payment-at-site", {}, idem),
      action(booking, "payment-at-site", {}, idem),
    ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, 200, JSON.stringify(results[0]));
  booking = results[0].body.booking;
  customer = results[0].body.loyalty;
  assert.equal(customer.points, 20);
  assert.equal(customer.reservationCount, 1);
  assert.equal(customer.benefitStatus, "available");
  assert.equal(booking.paidAmountBani, 6000);
  assert.equal(
    (
      await getFirestore()
        .collection(`customers/${customer.id}/loyaltyLedger`)
        .get()
    ).size,
    1,
  );
  const arrival = await action(booking, "arrive");
  assert.equal(arrival.status, 200);
  booking = arrival.body.booking;
  const stats = (await call("GET", "/v1/admin/stats", staff)).body;
  assert.equal(stats.parked, 1);
  const departed = await action(booking, "depart");
  assert.equal(departed.status, 200);
  booking = departed.body.booking;
  assert.equal((await call("GET", "/v1/admin/stats", staff)).body.parked, 0);
});
test("one-use benefits cannot be reserved concurrently; unpaid cancellation releases reservation", async () => {
  const quote = (
    await call("POST", "/v1/quotes", guest, {
      arrival: input.arrival,
      departure: input.departure,
      applyBenefit: true,
    })
  ).body.quote;
  assert.equal(quote.discountBani, 600);
  const payload = {
    ...input,
    applyBenefit: true,
    configRevision: quote.configRevision,
    benefitRevision: quote.benefitRevision,
    expiresAt: quote.expiresAt,
  };
  const results = await Promise.all([
    call("POST", "/v1/bookings/requests", guest, payload),
    call("POST", "/v1/bookings/requests", guest, payload),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  let b = results.find((r) => r.status === 200).body.booking;
  assert.equal(
    (await call("GET", "/v1/loyalty", guest)).body.loyalty.benefitStatus,
    "reserved",
  );
  const cancelled = await action(b, "cancel", { reason: "Clientul renunță" });
  assert.equal(cancelled.status, 200);
  assert.equal(
    (await call("GET", "/v1/loyalty", guest)).body.loyalty.benefitStatus,
    "available",
  );
  const quote2 = (
    await call("POST", "/v1/quotes", guest, {
      arrival: input.arrival,
      departure: input.departure,
      applyBenefit: true,
    })
  ).body.quote;
  b = (
    await call("POST", "/v1/bookings/requests", guest, {
      ...payload,
      benefitRevision: quote2.benefitRevision,
      expiresAt: quote2.expiresAt,
    })
  ).body.booking;
  b = (await action(b, "confirm")).body.booking;
  b = (await action(b, "payment-at-site")).body.booking;
  assert.equal(b.paidAmountBani, 5400);
  assert.equal(
    (await call("GET", "/v1/loyalty", guest)).body.loyalty.benefitStatus,
    "consumed",
  );
  const cancelPaid = await action(b, "cancel", {
    reason: "Anulare după încasare",
  });
  assert.equal(cancelPaid.status, 200);
  assert.equal(cancelPaid.body.booking.paymentStatus, "paid_at_site");
  assert.equal(cancelPaid.body.loyalty.points, 40);
  assert.equal(cancelPaid.body.loyalty.benefitStatus, "consumed");
});
test("paid edits preserve financial snapshot, carry difference and audit; manual loyalty requires reason", async () => {
  const created = await call("POST", "/v1/admin/bookings", staff, {
    ...input,
    phone: "0700999888",
  });
  assert.equal(created.status, 200);
  let b = created.body.booking;
  b = (await action(b, "payment-at-site")).body.booking;
  const editedInput = {
    ...input,
    phone: b.phone,
    departure: day(6) + "T10:00",
  };
  assert.equal(
    (
      await call("PATCH", `/v1/admin/bookings/${b.id}`, staff, {
        expectedRevision: b.revision,
        details: editedInput,
      })
    ).status,
    400,
  );
  const edited = await call("PATCH", `/v1/admin/bookings/${b.id}`, staff, {
    expectedRevision: b.revision,
    reason: "Prelungire solicitată",
    details: editedInput,
  });
  assert.equal(edited.status, 200);
  b = edited.body.booking;
  assert.equal(b.pricing.totalBani, 6000);
  assert.equal(b.paidAmountBani, 6000);
  assert.equal(b.priceDifferenceBani, 3000);
  const c = edited.body.loyalty;
  assert.equal(
    (
      await call(
        "POST",
        `/v1/admin/customers/${c.id}/loyalty-adjustments`,
        staff,
        {
          expectedRevision: c.revision,
          pointsDelta: 5,
          benefitAction: "keep",
          reason: "",
        },
      )
    ).status,
    400,
  );
  const adjustment = await call(
    "POST",
    `/v1/admin/customers/${c.id}/loyalty-adjustments`,
    staff,
    {
      expectedRevision: c.revision,
      pointsDelta: 5,
      benefitAction: "keep",
      reason: "Corecție operator",
    },
  );
  assert.equal(adjustment.body.loyalty.points, 25);
  assert.equal((await call("GET",`/v1/admin/customers/${c.id}`,staff)).body.loyalty.points,25);
  assert.equal(
    (await call("GET", `/v1/admin/bookings/${b.id}/audit`, staff)).body.items
      .length,
    3,
  );
});
test("manual totals require a reason and cannot overwrite a collected amount", async () => {
  const details = { ...input, phone: "0700555999" };
  assert.equal(
    (
      await call("POST", "/v1/admin/bookings", staff, {
        ...details,
        manualTotalBani: 5100,
      })
    ).status,
    400,
  );
  const created = await call("POST", "/v1/admin/bookings", staff, {
    ...details,
    manualTotalBani: 5100,
    reason: "Tarif agreat cu clientul",
  });
  assert.equal(created.status, 200);
  let b = created.body.booking;
  assert.equal(b.pricing.totalBani, 5100);
  assert.equal(b.pricing.manualAdjustmentBani, -900);
  b = (await action(b, "payment-at-site")).body.booking;
  const changed = await call("PATCH", `/v1/admin/bookings/${b.id}`, staff, {
    expectedRevision: b.revision,
    details,
    manualTotalBani: 5000,
    reason: "Încercare schimbare încasare",
  });
  assert.equal(changed.status, 409);
  assert.equal(
    (await call("GET", `/v1/admin/bookings/${b.id}`, staff)).body.booking
      .paidAmountBani,
    5100,
  );
});
test("notification watermark and individual reads do not erase newer unread messages", async () => {
  const before = (await call("GET", "/v1/notifications/meta", guest)).body.meta;
  assert.ok(before.unread > 0);
  const items = (await call("GET", "/v1/notifications", guest)).body.items;
  const all = (await call("POST", "/v1/notifications/read-all", guest, {})).body
    .meta;
  assert.equal(all.unread, 0);
  const created = await call("POST", "/v1/admin/bookings", staff, {
    ...input,
    customerId: customer.id,
  });
  assert.equal(created.status, 200);
  const after = (await call("GET", "/v1/notifications/meta", guest)).body.meta;
  assert.equal(after.unread, 1);
  const readOld = await call(
    "POST",
    `/v1/notifications/${items[0].id}/read`,
    guest,
    {},
  );
  assert.equal(readOld.body.meta.unread, 1);
  assert.equal(
    (await call("POST", `/v1/notifications/${items[0].id}/read`, other, {}))
      .status,
    404,
  );
});
test("reminders are indexed, version-aware and idempotent", async () => {
  const b = (
    await call("POST", "/v1/admin/bookings", staff, {
      ...input,
      customerId: customer.id,
    })
  ).body.booking;
  const ref = getFirestore().doc(`jobs/${b.id}_arrival`);
  await ref.update({ dueAt: Timestamp.fromMillis(Date.now() - 1000) });
  const first = await processNotificationJobs();
  assert.ok(first.delivered >= 1);
  const count = (
    await getFirestore().collection(`users/${guest.uid}/notifications`).get()
  ).size;
  await ref.update({ status: "pending" });
  await processNotificationJobs();
  assert.equal(
    (await getFirestore().collection(`users/${guest.uid}/notifications`).get())
      .size,
    count,
  );
});
test("filters, OR date semantics, stable pagination, recurring projection and complete CSV export", async () => {
  const fresh = await call("POST", "/v1/admin/bookings", staff, {
    ...input,
    phone: "0700999888",
  });
  assert.equal(fresh.status, 200);
  const clients = await call("GET", "/v1/admin/customers", staff);
  assert.equal(clients.status, 200, JSON.stringify(clients.body));
  assert.ok(clients.body.items.some((c) => c.phone === "0700999888"));
  for (const status of [
    "",
    "requested",
    "waiting",
    "parked",
    "departed",
    "cancelled",
  ])
    for (const payment of ["", "unpaid", "paid_at_site"])
      for (const source of ["", "app", "manual"]) {
        const q = new URLSearchParams({
          status,
          payment,
          source,
          from: day(4),
          to: day(5),
          search: "Ana",
        });
        const response = await call(
          "GET",
          "/v1/admin/bookings/search?" + q,
          staff,
        );
        assert.equal(
          response.status,
          200,
          JSON.stringify({ q: String(q), result: response.body }),
        );
      }
  const listed = await call("GET", "/v1/admin/bookings/search?limit=2", staff);
  assert.equal(listed.body.items.length, 2);
  assert.ok(listed.body.nextCursor);
  const second = await call(
    "GET",
    "/v1/admin/bookings/search?limit=2&cursor=" +
      encodeURIComponent(listed.body.nextCursor),
    staff,
  );
  assert.equal(second.status, 200);
  assert.equal(
    new Set([...listed.body.items, ...second.body.items].map((b) => b.id)).size,
    4,
  );
  assert.equal(
    (
      await call(
        "GET",
        "/v1/admin/bookings/search?search=Ana&cursor=" +
          encodeURIComponent(listed.body.nextCursor),
        staff,
      )
    ).status,
    400,
  );
  for (const tab of ["ongoing", "history", "upcoming"])
    assert.equal(
      (await call("GET", "/v1/bookings?tab=" + tab, guest)).status,
      200,
    );
  const reportDate = day(3);
  for (let start = 0; start < 501; start += 250) {
    const batch = getFirestore().batch();
    for (let n = start; n < Math.min(501, start + 250); n++)
      batch.set(getFirestore().doc(`movements/export_${n}`), {
        bookingId: "export",
        code: "IAS-" + n,
        kind: "arrival",
        active: true,
        scheduledAt: localInstant(reportDate + "T12:00"),
        scheduledLocal: reportDate + "T12:00",
        actualAt: null,
        name: n === 0 ? "=DANGEROUS" : "Test Export",
        phone: "+40700123456",
        licensePlate: "IS 01 TST",
        paymentStatus: "unpaid",
        amountBani: 3000,
      });
    await batch.commit();
  }
  const report = await call(
    "GET",
    `/v1/admin/reports?from=${reportDate}&to=${reportDate}`,
    staff,
  );
  assert.equal(report.status, 200);
  assert.equal(report.body.items.length, 100);
  assert.ok(report.body.nextCursor);
  const response = await fetch(
    `${base}/v1/admin/reports/export?from=${reportDate}&to=${reportDate}`,
    { headers: { Authorization: "Bearer " + staff.token } },
  );
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.ok(csv.split("\r\n").length > 502);
  assert.ok(csv.includes("'=DANGEROUS"));
  assert.ok(csv.includes("'+40700123456"));
});

test('disabled staff loses API access to notification metadata and inbox',async()=>{
 assert.equal((await call('GET','/v1/notifications/meta',operator)).status,200);
 await getFirestore().doc(`staffAccess/${operator.uid}`).update({enabled:false});
 for(const route of ['/v1/notifications/meta','/v1/notifications'])assert.equal((await call('GET',route,operator)).status,403);
 assert.equal((await call('POST','/v1/notifications/read-all',operator,{})).status,403);
});


test("early departures and cancellations belong only to history", async () => {
  const owner = await identity();
  await call("POST", "/v1/guest/session", owner, { email: "tabs@example.com", phone: "0700123456" });
  async function create() {
    const quote = (await call("POST", "/v1/quotes", owner, { arrival: input.arrival, departure: input.departure })).body.quote;
    const result = await call("POST", "/v1/bookings/requests", owner, { ...input, applyBenefit: false, configRevision: quote.configRevision, benefitRevision: quote.benefitRevision, expiresAt: quote.expiresAt });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.booking;
  }
  const waiting = await create();
  let departed = await create();
  for (const name of ["confirm", "arrive", "depart"]) {
    const result = await action(departed, name);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    departed = result.body.booking;
  }
  let cancelled = await create();
  const cancellation = await action(cancelled, "cancel", { reason: "Cerere client" });
  assert.equal(cancellation.status, 200);
  cancelled = cancellation.body.booking;
  const tabs = {};
  for (const tab of ["upcoming", "ongoing", "history"]) {
    const result = await call("GET", "/v1/bookings?tab=" + tab, owner);
    assert.equal(result.status, 200);
    tabs[tab] = result.body.items.map(b => b.id);
  }
  assert.ok(tabs.upcoming.includes(waiting.id));
  for (const b of [departed, cancelled]) {
    assert.ok(tabs.history.includes(b.id));
    assert.ok(!tabs.upcoming.includes(b.id));
    assert.ok(!tabs.ongoing.includes(b.id));
  }
});

test("untrusted cursors and out-of-range asOf are permanent validation errors", async () => {
  const first = await call("GET", "/v1/admin/bookings/search?limit=1", staff);
  assert.ok(first.body.nextCursor);
  const valid = JSON.parse(Buffer.from(first.body.nextCursor, "base64url").toString());
  for (const value of [null, [], true, "cursor", 1, {},
    {...valid, value: 1e100}, {...valid, value: -1e100},
    {...valid, value: 253402300800000}, {...valid, value: -62135596800001},
    {...valid, value: "not-a-timestamp"}, {...valid, id: "a/b"},
    {...valid, extra: [1e100]}, {...valid, q: "other-scope"}]) {
    const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
    const result = await call("GET", "/v1/admin/bookings/search?cursor=" + cursor, staff);
    assert.equal(result.status, 400, JSON.stringify({value, result}));
    assert.equal(result.body.code, "VALIDATION_ERROR");
    assert.equal(result.body.retryable, false);
  }
  // Ongoing cursors also contain a secondary departure timestamp.
  const owner = await identity();
  const source = (await getFirestore().doc(`bookings/${booking.id}`).get()).data();
  const batch = getFirestore().batch();
  for (let n = 0; n < 2; n++) batch.set(getFirestore().doc(`bookings/cursor-extra-${n}`), {
    ...source, ownerUid: owner.uid, bookingStatus: "confirmed", movementStatus: "parked",
    arrivalAt: Timestamp.fromMillis(Date.now() - 3600000),
    departureAt: Timestamp.fromMillis(Date.now() + 3600000),
  });
  await batch.commit();
  const ongoing = await call("GET", "/v1/bookings?tab=ongoing&limit=1", owner);
  const cursor = JSON.parse(Buffer.from(ongoing.body.nextCursor, "base64url").toString());
  cursor.extra = [1e100];
  const invalid = await call("GET", "/v1/bookings?tab=ongoing&asOf=" + encodeURIComponent(ongoing.body.asOf) + "&cursor=" + Buffer.from(JSON.stringify(cursor)).toString("base64url"), owner);
  assert.equal(invalid.status, 400);
  assert.equal((await call("GET", "/v1/bookings?asOf=%2B010000-01-01T00%3A00%3A00.000Z", owner)).status, 400);
});
