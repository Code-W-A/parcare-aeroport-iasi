const fs = require("node:fs");
const path = require("node:path");
const indexes = [];
const seen = new Set();
function add(collection, eq, order, array = []) {
  const fields = [
    ...eq.map((fieldPath) => ({ fieldPath, order: "ASCENDING" })),
    ...array.map((fieldPath) => ({ fieldPath, arrayConfig: "CONTAINS" })),
    ...order.map(([fieldPath, order]) => ({ fieldPath, order })),
    ...(order.length > 1 && order.at(-1)[1] !== order[0][1]
      ? [{ fieldPath: "__name__", order: order[0][1] }]
      : []),
  ];
  if (fields.length < 2) return; // Single-field ordering uses built-in indexes.
  const key = JSON.stringify([collection, fields]);
  if (!seen.has(key)) {
    seen.add(key);
    indexes.push({
      collectionGroup: collection,
      queryScope: "COLLECTION",
      fields,
    });
  }
}
// Every supported admin equality/search combination, with each arm of the date OR.
for (const state of [
  [],
  ["bookingStatus"],
  ["bookingStatus", "movementStatus"],
])
  for (const payment of [[], ["paymentStatus"]])
    for (const source of [[], ["source"]])
      for (const search of [[], ["searchPrefixes"]])
        for (const range of [null, "arrivalDay", "departureDay"])
          add(
            "bookings",
            [...state, ...payment, ...source],
            [
              ["arrivalAt", "DESCENDING"],
              ...(range
                ? [
                    ["arrivalDay", "ASCENDING"],
                    ["departureDay", "ASCENDING"],
                  ]
                : []),
            ],
            search,
          );
for (const direction of ["ASCENDING", "DESCENDING"]) {
  add("bookings", ["ownerUid", "bookingStatus"], [["arrivalAt", direction]]);
  add("bookings", ["ownerUid", "bookingStatus", "movementStatus"], [["arrivalAt", direction]]);
  add(
    "bookings",
    ["ownerUid", "bookingStatus", "movementStatus"],
    [
      ["arrivalAt", direction],
      ["departureAt", "ASCENDING"],
    ],
  );
  add("bookings", ["ownerUid"], [["departureAt", direction]]);
  add("bookings", ["ownerUid", "bookingStatus"], [["departureAt", direction]]);
  add("bookings", ["ownerUid", "movementStatus"], [["departureAt", direction]]);
}
add("bookings", ["customerId"], [["arrivalAt", "DESCENDING"]]);
add(
  "bookings",
  ["bookingStatus", "movementStatus"],
  [
    ["arrivalAt", "ASCENDING"],
    ["arrivalDay", "ASCENDING"],
  ],
);
add(
  "bookings",
  ["bookingStatus", "movementStatus"],
  [
    ["departureAt", "ASCENDING"],
    ["departureDay", "ASCENDING"],
  ],
);
add(
  "bookings",
  ["bookingStatus", "movementStatus"],
  [["departureAt", "ASCENDING"]],
);
add(
  "customers",
  [],
  [
    ["name", "ASCENDING"],
    ["reservationCount", "ASCENDING"],
  ],
);
add(
  "customers",
  [],
  [
    ["name", "ASCENDING"],
    ["reservationCount", "ASCENDING"],
  ],
  ["searchPrefixes"],
);
add("movements", ["active"], [["scheduledAt", "ASCENDING"]]);
add("movements", ["active", "kind"], [["scheduledAt", "ASCENDING"]]);
add("jobs", ["status"], [["dueAt", "ASCENDING"]]);
const fieldOverrides = [
  ["audit", "changes"],
  ["bookings", "providerPayload"],
  ["bookings", "pricing"],
  ["notifications", "message"],
  ["loyaltyLedger", "reason"],
  ["idempotency", "result"],
  ["idempotency", "fingerprint"],
].map(([collectionGroup, fieldPath]) => ({
  collectionGroup,
  fieldPath,
  indexes: [],
}));
fs.writeFileSync(
  path.join(__dirname, "../firestore.indexes.json"),
  JSON.stringify({ indexes, fieldOverrides }, null, 2) + "\n",
);
console.log(`${indexes.length} indexes generated.`);
