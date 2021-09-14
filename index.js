require('dotenv').config()
const fs = require('fs')
const mergeFiles = require('merge-files')

async function download(s3_client, s3_params, options) {
    console.log("Starting parallel download");
    var file_size = await s3_client.headObject(s3_params).promise().then(res => res.ContentLength);
    console.log("Total file size to Download", file_size);
    var range = getIntervals(file_size, options.parallel_count, s3_client, s3_params, options)
    var actions = range.map(parallelDownloadStart)
    var results = await Promise.all(actions);
    const outputPath = options.download_dir + s3_params.Key.substring(s3_params.Key.lastIndexOf('/') + 1);
    console.log("Merging Part files");
    const status = await mergeFiles(results, outputPath);
    console.log("Cleanup Part files");
    await deletePartFiles(results);
    console.log("Downloaded File Present in Path:", outputPath);
    return status
}

function parallelDownloadStart(v) {
    return new Promise(function (resolve, reject) {
        console.log("Download startd for", v[5].download_dir + v[4].Key.substring(v[4].Key.lastIndexOf('/') + 1) + "-part-" + v[2]);
        v[4].Range = "bytes=" + v[0] + "-" + v[1]
        v[3].getObject(v[4], function (err, data) {
            if (err) { reject(err); throw err }
            if (!fs.existsSync(v[5].download_dir)) fs.mkdirSync(download_dir, { recursive: true });
            var file_path = v[5].download_dir + v[4].Key.substring(v[4].Key.lastIndexOf('/') + 1) + "-part-" + v[2]
            fs.writeFileSync(file_path, data.Body)
            console.log('Part file downloaded successfully', file_path)
            resolve(file_path)
        })
    });
};

async function deletePartFiles(list) {
    for (let i = 0; i < list.length; i++) {
        if (fs.existsSync(list[i])) {
            fs.unlinkSync(list[i])
        }
    }
}

function getIntervals(interval, num, s3_client, s3_params, options) {
    const size = Math.floor(interval / num);
    const res = [];
    var count = 0
    for (let i = 0; i <= interval;
        i += size) {
        const a = i == 0 ? i : i += 1;
        const b = i + size > interval ? interval : i + size;
        if (a < interval) {
            res.push([a, b, count, s3_client, s3_params, options]);
            count++
        };
    };
    return res;
};

module.exports.download = download