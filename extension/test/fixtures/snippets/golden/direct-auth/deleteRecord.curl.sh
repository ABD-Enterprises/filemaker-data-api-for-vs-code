# This deletes the record when sent.
curl -X DELETE 'https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records/42' -H "Authorization: Bearer $FM_TOKEN"