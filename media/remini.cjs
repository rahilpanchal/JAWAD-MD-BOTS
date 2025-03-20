// KHAN-MD-V1

const FormData = require("form-data");

async function remini(imageBuffer, effect) {
  return new Promise(async (resolve, reject) => {
    let validEffects = ['enhance', "recolor", "dehaze"];
    if (validEffects.includes(effect)) {
      effect = effect;
    } else {
      effect = validEffects[0]; // Default to 'enhance'
    }

    let formData = new FormData();
    let apiUrl = "https://inferenceengine.vyro.ai/" + effect;

    formData.append("model_version", 1, {
      'Content-Transfer-Encoding': "binary",
      'contentType': "multipart/form-data; charset=utf-8"
    });

    formData.append('image', Buffer.from(imageBuffer), {
      'filename': "enhance_image_body.jpg",
      'contentType': "image/jpeg"
    });

    formData.submit({
      'url': apiUrl,
      'host': "inferenceengine.vyro.ai",
      'path': '/' + effect,
      'protocol': "https:",
      'headers': {
        'User-Agent': 'okhttp/4.9.3',
        'Connection': "Keep-Alive",
        'Accept-Encoding': "gzip"
      }
    }, function (error, response) {
      if (error) {
        reject();
      }

      let chunks = [];
      response.on('data', function (chunk) {
        chunks.push(chunk);
      }).on("end", () => {
        resolve(Buffer.concat(chunks));
      });

      response.on("error", () => {
        reject();
      });
    });
  });
}

module.exports.remini = remini;
