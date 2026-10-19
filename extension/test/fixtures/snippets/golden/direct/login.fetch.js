// Fill in the account name and password yourself (never copied). The response holds the session token.
const basic = Buffer.from(`${process.env.FM_USERNAME ?? "<account name>"}:${process.env.FM_PASSWORD ?? "<password>"}`).toString("base64");
const response = await fetch("https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/sessions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Basic ${basic}`
  },
  body: "{}",
});
const data = await response.json();