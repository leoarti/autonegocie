if (!process.env.FUNCTIONS_BASE_URL) {
  process.env.FUNCTIONS_BASE_URL = `http://127.0.0.1:${process.env.PORT || 8787}`;
}
if (!process.env.FIREBASE_PROJECT_ID) {
  process.env.FIREBASE_PROJECT_ID = 'autonegocie-257c3';
}

require('./server');
