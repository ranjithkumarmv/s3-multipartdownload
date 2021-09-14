# s3-multipartdownload

s3-multipartdownload is high level client(wrapper) on top of s3 get Object uses Range option to parallelize the download of the object in s3.

## Installation

Use the package manager [npm](https://www.npmjs.com/package/s3-multipartdownload) to install s3-multipartdownload.

```bash
npm i s3-multipartdownload
```

## Usage

```python
const AWS = require('aws-sdk')
const s3_multipart_downloader = require('s3-multipartdownload');

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
```

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License
[MIT](https://choosealicense.com/licenses/mit/)