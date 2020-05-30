document.addEventListener('DOMContentLoaded', () => init());

let EdDSA;
let eddsa;

async function init() {

  $('#generate').on('click', () => generate());

  EdDSA = elliptic.eddsa;
  eddsa = new EdDSA('ed25519');
}

function generate() {
  let password1 = $('#password1').val();
  let password2 = $('#password2').val();
  if (password1 == '') {
    $('.toast-header').removeClass('bg-success').addClass('bg-danger');
    showNotification('Введите пароль');
    return;
  }
  if (password1 != password2) {
    $('.toast-header').removeClass('bg-success').addClass('bg-danger');
    showNotification('Пароли не совпадают');
    return;
  }
  $('.toast-header').removeClass('bg-danger').addClass('bg-success');
  showNotification('Ключ успешно создан');
  let key = eddsa.keyFromSecret(CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Hex));
  let publicKey = key.getPublic('hex');
  let encryptedPrivateKey = CryptoJS.AES.encrypt(key.getSecret('hex'), password1).toString();
  console.log(encryptedPrivateKey);
  $('#publicKey').val(publicKey);
  download('privateKey.key', encryptedPrivateKey);
}

function showNotification(text) {
  $('#notification').html(text);
  $('.toast').toast('show');
}

function download(filename, text) {
  var element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
  element.setAttribute('download', filename);

  element.style.display = 'none';
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}

