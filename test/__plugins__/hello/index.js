import Plugin from '../../../dist/abstract/plugin.js';

class HelloWorldPath extends Plugin {
  name = 'hellopath';

  api(app) {
    console.debug('Hello plugin loaded - routes: GET /hello');
    console.debug(' => I stored caller object to have hooks later');
    app.get('/hellopath', (req, res) => {
      const response = { message: 'Hello path' };
      res.json(response);
    });
  }
}

export { HelloWorldPath as default };
//# sourceMappingURL=helloworld.js.map
