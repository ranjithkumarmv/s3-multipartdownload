const AWS = require('aws-sdk')
const s3_multipart_downloader = require('./index');

// general s3 getObject params
var s3_client = new AWS.S3({
    accessKeyId: "",    //required
    secretAccessKey: "" //required
})

var s3_params = {
    Bucket: "",        //required
    Key: ""            //required
}

// related to multipart download library
var options = {
    parallel_count: 3,
    download_dir: "./data/download/"
}

s3_multipart_downloader.download(s3_client, s3_params, options)