function getGPSLocation() {
  return new Promise((resolve) => {
    let settled = false;

    if (!navigator.geolocation) {
      if (!settled) { settled = true; resolve({ latitude: '', longitude: '', accuracy: null, errorCode: null }); }
      return;
    }

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.warn("GPS JS Timeout after 15000ms.");
        resolve({ latitude: '', longitude: '', accuracy: null, errorCode: 3 });
      }
    }, 15000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolve({
            latitude:  pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy:  pos.coords.accuracy,
            errorCode: null
          });
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          console.warn("GPS Error:", err);
          resolve({ latitude: '', longitude: '', accuracy: null, errorCode: err.code });
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );
  });
}

function capturePhoto() {
  return new Promise((resolve) => {
    const input = document.getElementById('camera-input');
    if (!input) {
      resolve(null);
      return;
    }

    const onFileChange = async (e) => {
      input.removeEventListener('change', onFileChange);
      const file = e.target.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const compressedBlob = await compressImage(file);
        resolve(compressedBlob);
      } catch (err) {
        console.error("Compression failed, uploading original:", err);
        resolve(file);
      } finally {
        input.value = '';
      }
    };

    input.addEventListener('change', onFileChange);
    input.click();
  });
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const MAX_LEN = 1200;

        if (width > height) {
          if (width > MAX_LEN) {
            height = Math.round((height * MAX_LEN) / width);
            width = MAX_LEN;
          }
        } else {
          if (height > MAX_LEN) {
            width = Math.round((width * MAX_LEN) / height);
            height = MAX_LEN;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          if (blob) {
            console.log(`Compressed image: ${(blob.size / 1024).toFixed(1)} KB`);
            resolve(blob);
          } else {
            reject(new Error("Canvas toBlob returned null"));
          }
        }, "image/jpeg", 0.6);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.getGPSLocation = getGPSLocation;
window.capturePhoto = capturePhoto;
window.compressImage = compressImage;
