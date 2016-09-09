const ottoman = require('ottoman'),
      Customer = ottoman.model('Customer', {
        name: { type: 'string' },
      },
      Store = ottoman.model('Store', {
        name: { type: 'string' },
        customers: [{ ref: 'Customer' }],
      },
      Product = ottoman.model('Product', {
        name: { type: 'string' },
        store: { ref: 'Store' },
      },
      customer = new Customer({
        name: 'John'
      }),
      store = new Store({
        name: 'Johns Store'
        customers: [customer],
      }),
      product = new Product({
        name: 'Johns Product',
        store: store,
      });

// OPTION 1: deep boolean on save
product.save({ deep: true }, (err) => {
  if (err) throw err;
})

// OPTION 2: explicit model references on save
product.save({ ref: ['store', 'store.customers[*]'] }, (err) => {
  if (err) throw err;
})

// OPTION 3: as an extension to the ottoman prototype
ottoman.save(customer, store, product, (err) => {
  if (err) throw err;
});
