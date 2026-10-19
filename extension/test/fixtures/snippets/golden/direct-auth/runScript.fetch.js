const token = process.env.FM_TOKEN ?? "<session token>";
const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/script/Send%20Welcome?script.param=%7B%22id%22%3A%2042%2C%20%22note%22%3A%20%22a%20b%26c%22%7D", {
  method: "GET",
  headers: {
    "Authorization": `Bearer ${token}`
  },
});
const data = await response.json();