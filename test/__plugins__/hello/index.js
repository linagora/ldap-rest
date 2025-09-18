const helloPlugin = app => {
  app.get('/hellopath', (req, res) => {
    res.json({ message: 'Hello path' });
  });
  console.debug('Hello plugin loaded - routes: GET /hellopath');
};

export { helloPlugin as default };
//# sourceMappingURL=helloworld.js.map
