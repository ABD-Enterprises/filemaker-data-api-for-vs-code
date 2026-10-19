// Replace the modId with the one from the record you read: FileMaker refuses the edit (error 306) if the record changed since.
const token = process.env.FM_TOKEN ?? "<session token>";
const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records/42", {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  },
  body: "{\"fieldData\":{\"Status\":\"Inactive\"},\"modId\":\"<modId>\"}",
});
const data = await response.json();