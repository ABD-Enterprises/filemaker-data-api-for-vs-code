// This deletes the record when sent.
const token = process.env.FM_TOKEN ?? "<session token>";
const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records/42", {
  method: "DELETE",
  headers: {
    "Authorization": `Bearer ${token}`
  },
});
const data = await response.json();