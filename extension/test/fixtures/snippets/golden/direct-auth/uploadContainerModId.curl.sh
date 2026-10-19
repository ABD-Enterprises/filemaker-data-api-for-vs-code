# Replace ./file-to-upload with the path of the file to send.
# Replace the modId with the one from the record you read.
curl -X POST 'https://fm.example.com/fmi/data/vLatest/databases/Sales%20DB/layouts/Contacts/records/42/containers/Photo/2?modId=<modId>' -H "Authorization: Bearer $FM_TOKEN" -F 'upload=@./file-to-upload'