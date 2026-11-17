"use client";
import { detailFields, type CustomerDetails } from "../../lib/booking-details";
export function CustomerDetailsForm({
  value,
  onChange,
}: {
  value: CustomerDetails;
  onChange: (d: CustomerDetails) => void;
}) {
  return (
    <fieldset>
      <legend>Contact, transfer și facturare</legend>
      <div className="form-grid">
        <label>
          Facturare
          <select
            value={value.billingType}
            onChange={(e) =>
              onChange({
                ...value,
                billingType: e.target.value as CustomerDetails["billingType"],
              })
            }
          >
            <option value="individual">Persoană fizică</option>
            <option value="company">Firmă</option>
          </select>
        </label>
        <label>
          Persoane transfer
          <input
            type="number"
            required
            min="1"
            step="1"
            value={value.numberOfPersons || ""}
            onChange={(e) =>
              onChange({ ...value, numberOfPersons: Number(e.target.value) })
            }
          />
        </label>
        {detailFields
          .filter(
            ([, , group]) =>
              group !== "company" || value.billingType === "company",
          )
          .map(([key, label, , max]) => (
            <label key={key}>
              {label}
              {key === "orderNotes" ? " (opțional)" : ""}
              <input
                type={key === "email" ? "email" : "text"}
                required={key !== "orderNotes"}
                maxLength={max}
                value={value[key]}
                onChange={(e) => onChange({ ...value, [key]: e.target.value })}
              />
            </label>
          ))}
      </div>
    </fieldset>
  );
}
export function CustomerDetailsReadOnly({
  value,
}: {
  value?: CustomerDetails;
}) {
  if (!value) return <p>Date suplimentare: Nespecificat</p>;
  return (
    <dl className="form-grid details">
      <div>
        <dt>Persoane transfer</dt>
        <dd>{value.numberOfPersons}</dd>
      </div>
      <div>
        <dt>Facturare</dt>
        <dd>{value.billingType === "company" ? "Firmă" : "Persoană fizică"}</dd>
      </div>
      {detailFields
        .filter(
          ([, , group]) =>
            group !== "company" || value.billingType === "company",
        )
        .map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{value[key] || "—"}</dd>
          </div>
        ))}
    </dl>
  );
}
