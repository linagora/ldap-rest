const api = app => {
  app.get('/hellopath', (req, res) => {
    res.json({ message: 'Hello path' });
  });
  console.debug('Hellopath plugin loaded - routes: GET /hellopath');
};

export { api };
//# sourceMappingURL=helloworld.js.map
