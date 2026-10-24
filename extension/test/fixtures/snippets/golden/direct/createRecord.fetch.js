const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <REDACTED>"
  },
  body: "{\"fieldData\":{\"Name\":\"Ada Lovelace\",\"Email\":\"ada@example.com\"}}",
});
const data = await response.json();