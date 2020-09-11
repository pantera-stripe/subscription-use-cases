let stripe, customer, price, card;

let priceInfo = {
  basic: {
    amount: '500',
    name: 'Basic',
    interval: 'monthly',
    currency: 'USD',
  },
  premium: {
    amount: '1500',
    name: 'Premium',
    interval: 'monthly',
    currency: 'USD',
  },
};

function stripeElements(publishableKey) {
  stripe = Stripe(publishableKey);

  if (document.getElementById('card-element')) {
    let elements = stripe.elements();

    // Card Element styles
    let style = {
      base: {
        fontSize: '16px',
        color: '#32325d',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
        fontSmoothing: 'antialiased',
        '::placeholder': {
          color: '#a0aec0',
        },
      },
    };

    card = elements.create('card', { style: style });

    card.mount('#card-element');

    card.on('focus', function () {
      let el = document.getElementById('card-element-errors');
      el.classList.add('focused');
    });

    card.on('blur', function () {
      let el = document.getElementById('card-element-errors');
      el.classList.remove('focused');
    });

    card.on('change', function (event) {
      displayError(event);
    });
  }

  let signupForm = document.getElementById('signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', function (evt) {
      evt.preventDefault();
      changeLoadingState(true);
      // Create customer
      createCustomer().then((result) => {
        customer = result.customer;

        window.location.href = '/prices.html?customerId=' + customer.id;
      });
    });
  }

  const paymentForm = document.getElementById('payment-form');
  if (paymentForm) {
    paymentForm.addEventListener('submit', function (evt) {
      evt.preventDefault();
      changeLoadingStatePrices(true);

      const params = new URLSearchParams(window.location.search);
      const customerId = params.get('customerId');
      
      const priceId = getPriceId();
      getOrCreateIncompleteSubscription({customerId, priceId})
      .then(({clientSecret, subscriptionId, currentPeriodEnd}) =>  {
        // Pay using the payment information colllected from the user. Successful payment will automatically
        // activate the subscription.
        pay({clientSecret, card})
          // This can also be structured this as if/then clauses rather than cascading handlers
          .then(handlePaymentThatRequiresCustomerAction)
          .then(handleRequiresPaymentMethod)
          // TODO: handle confirm? See if there is a scenario where this actually happens
          .then((result) => {
            // TODO: set as default payment method on customer in the complete callback
            onSubscriptionComplete({
              priceId,
              subscriptionId,
              currentPeriodEnd,
              customerId,
              paymentMethodId: result.payment_method,
            })
          })
          // catch for pay or any of the handlers in that chain
          .catch((result) => {
            const {error}  = result;
            if (error) {
              displayError({error})
            } else {
              console.log('Payment handling unexpected error');
              console.log(result);
              displayError({ error: { message: 'Unexpected error. Try again or contact our support team.'} })
            }
          });
      })
      // catch for getOrCreateIncompleteSubscription
      .catch((error) => {
        displayError(error);
      });
    });
  }
}

function displayError(event) {
  changeLoadingStatePrices(false);
  // Display the failure to the user here. Utilize the HTML element we created.
  let displayError = document.getElementById('card-element-errors');
  if (event.error) {
    displayError.textContent = event.error.message;
  } else {
    displayError.textContent = '';
  }
}

async function getOrCreateIncompleteSubscription({customerId, priceId}) {
  const subscriptionId = localStorage.getItem('incompleteSubscriptionId');
  const currentPeriodEnd = localStorage.getItem('currentPeriodEnd');
  const clientSecret = localStorage.getItem('clientSecret');
  const incompleteSubscriptionPriceId = localStorage.getItem('incompleteSubscriptionPriceId');
  const subscriptionInCache = subscriptionId && currentPeriodEnd && clientSecret;
  const priceIdChanged = subscriptionInCache && (priceId !== incompleteSubscriptionPriceId);

  // As a shortcut, return cached info from local storage if we can.
  if (subscriptionInCache && !priceIdChanged) {
    return {clientSecret, subscriptionId, currentPeriodEnd};
  }
  
  if (priceIdChanged) {
    // Customer may have gone back and changed their plan after an incomplete subscription was created for that plan.
    // Clean up that subscription by cancelling it. Don't need to wait on this response.
    cancelSubsciptionApiCall(subscriptionId);
  }
  
  return createSubscription({customerId, priceId})
    .then((subscription) => {
      if (subscription) {
        // Caching for responsiveness. Could take simpler approach and re-fetch the subscription/payment intent to get latest state.
        localStorage.setItem('clientSecret', subscription.latest_invoice.payment_intent.client_secret);
        localStorage.setItem('incompleteSubscriptionId', subscription.id);
        localStorage.setItem('currentPeriodEnd', subscription.current_period_end);
        localStorage.setItem('incompleteSubscriptionPriceId', priceId);
        return {
          clientSecret: subscription.latest_invoice.payment_intent.client_secret,
          subscriptionId: subscription.id, 
          currentPeriodEnd: subscription.current_period_end};
      } else {
        throw {error: {message: 'There was a problem creating the subscription.'}}
      }
    })
}

async function createSubscription({ customerId, priceId }) {
  return fetch('/create-subscription', {
      method: 'post',
      headers: {
        'Content-type': 'application/json',
      },
      body: JSON.stringify({
        customerId,
        priceId,
      }),
    })
    .then((response) => {
      return response.json();
    })
}

function pay({clientSecret, card}) {
  const billingName = document.querySelector('#name').value;
  return stripe.confirmCardPayment(clientSecret, {
    payment_method: {
      card,
      billing_details: {
        name: billingName,
      }
    }
  })
  .then((result) => {
    if (result.error) {
      // start code flow to handle updating the payment details
      // Display error message in your UI.
      // The card was declined (i.e. insufficient funds, card has expired, etc)
      throw result;
    } else {
      return result.payment_intent;
    }
  })
}

function handlePaymentThatRequiresCustomerAction(paymentIntent) {
  if (paymentIntent.status !== 'requires_action') {
    return paymentIntent
  }
  return stripe
    .handleCardAction(paymentIntent.client_secret)
    .then((result) => {
      if (result.error) {
        // start code flow to handle updating the payment details
        // Display error message in your UI.
        // The card was declined (i.e. insufficient funds, card has expired, etc)
        throw result;
      } else {
        return result.payment_intent
      }
    });
}

function handleRequiresPaymentMethod(paymentIntent) {
  if (paymentIntent.status === 'requires_payment_method') {
    throw { error: { message: 'Your card was declined.' } };
  } else {
    return paymentIntent
  }
}

function selectPrice(priceId) {
  // Show which price the user selected
  if (priceId === 'premium') {
    document.querySelector('#submit-premium-button-text').innerText =
      'Selected';
    document.querySelector('#submit-basic-button-text').innerText = 'Select';
    document.querySelector('#submit-price').disabled = false;
  } else if (priceId === 'basic') {
    document.querySelector('#submit-premium-button-text').innerText = 'Select';
    document.querySelector('#submit-basic-button-text').innerText = 'Selected';
    document.querySelector('#submit-price').disabled = false
  } else {
    document.querySelector('#submit-price').disabled = true;
  }
  setPriceId(priceId);
  // Update the border to show which price is selected
  changePriceSelection(priceId);
}

function goToPaymentPage() {
  // Show the payment screen
  document.querySelector('#payment-view').classList.remove('hidden');
  document.querySelector('#price-picker').classList.add('hidden');

  const priceId = getPriceId();
  document.getElementById('total-due-now').innerText = getFormattedAmount(
    priceInfo[priceId].amount
  );

  // Add the price selected
  document.getElementById('price-selected').innerHTML =
    '→ Subscribing to ' +
    '<span id="priceId" class="font-bold">' +
    priceInfo[priceId].name +
    '</span>';
}

function goToPricePicker() {
  document.querySelector('#payment-view').classList.add('hidden');
  document.querySelector('#price-picker').classList.remove('hidden');
}

function changePrice() {
  demoChangePrice();
}

function switchPrices(newPriceIdSelected) {
  const params = new URLSearchParams(document.location.search.substring(1));
  const currentSubscribedpriceId = params.get('priceId');
  const customerId = params.get('customerId');
  const subscriptionId = params.get('subscriptionId');
  // Update the border to show which price is selected
  changePriceSelection(newPriceIdSelected);

  changeLoadingStateAccountPage(true);

  // Retrieve the upcoming invoice to display details about
  // the price change
  retrieveUpcomingInvoice(customerId, subscriptionId, newPriceIdSelected).then(
    (upcomingInvoice) => {
      // Change the price details for price upgrade/downgrade
      // calculate if it's upgrade or downgrade
      document.getElementById(
        'current-price-subscribed'
      ).innerHTML = capitalizeFirstLetter(currentSubscribedpriceId);

      document.getElementById(
        'new-price-selected'
      ).innerText = capitalizeFirstLetter(newPriceIdSelected);

      document.getElementById('new-price-price-selected').innerText =
        '$' + upcomingInvoice.amount_due / 100;

      let nextPaymentAttemptDateToDisplay = getDateStringFromUnixTimestamp(
        upcomingInvoice.next_payment_attempt
      );
      document.getElementById(
        'new-price-start-date'
      ).innerHTML = nextPaymentAttemptDateToDisplay;

      changeLoadingStateAccountPage(false);
    }
  );

  if (currentSubscribedpriceId != newPriceIdSelected) {
    document.querySelector('#price-change-form').classList.remove('hidden');
  } else {
    document.querySelector('#price-change-form').classList.add('hidden');
  }
}

function confirmPriceChange() {
  const params = new URLSearchParams(document.location.search.substring(1));
  const subscriptionId = params.get('subscriptionId');
  let newPriceId = document.getElementById('new-price-selected').innerHTML;

  updateSubscription(newPriceId.toUpperCase(), subscriptionId).then(
    (result) => {
      let searchParams = new URLSearchParams(window.location.search);
      searchParams.set('priceId', newPriceId.toUpperCase());
      searchParams.set('priceHasChanged', true);
      window.location.search = searchParams.toString();
    }
  );
}

function createCustomer() {
  let billingEmail = document.querySelector('#email').value;

  return fetch('/create-customer', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: billingEmail,
    }),
  })
    .then((response) => {
      return response.json();
    })
    .then((result) => {
      return result;
    });
}

function onSubscriptionComplete(result) {
  console.log(result);
  const {customerId, paymentMethodId} = result;
  // Payment was successful. Provision access to your service.
  // Also, set this new payment method as their customer's default
  // for this and future subscriptions.
  setDefaultPaymentMethod({customerId, paymentMethodId});

  // Remove invoice from localstorage because payment is now complete.
  clearCache();

  changeLoadingStatePrices(false);

  // Change your UI to show a success message to your customer.
  onSubscriptionSampleDemoComplete(result);
  // Call your backend to grant access to your service based on
  // the product your customer subscribed to.
  // Get the product by using result.subscription.price.product
}

async function setDefaultPaymentMethod({customerId, paymentMethodId}) {
  return fetch('/set-default-payment-method',  {
    method: 'post',
    headers: {
      'Content-type': 'application/json',
    },
    body: JSON.stringify({
      customerId,
      paymentMethodId,
    }),
  })
    .then((response) => {
      return response.json();
    });
}

function retrieveUpcomingInvoice(customerId, subscriptionId, newPriceId) {
  return fetch('/retrieve-upcoming-invoice', {
    method: 'post',
    headers: {
      'Content-type': 'application/json',
    },
    body: JSON.stringify({
      customerId: customerId,
      subscriptionId: subscriptionId,
      newPriceId: newPriceId,
    }),
  })
    .then((response) => {
      return response.json();
    })
    .then((invoice) => {
      return invoice;
    });
}

async function cancelSubsciptionApiCall(subscriptionId) {
  return fetch('/cancel-subscription', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subscriptionId: subscriptionId,
    }),
  })
    .then((response) => {
      return response.json();
    })
}
function cancelSubscription() {
  changeLoadingStateAccountPage(true);
  const params = new URLSearchParams(document.location.search.substring(1));
  const subscriptionId = params.get('subscriptionId');

  return cancelSubsciptionApiCall(subscriptionId)
    .then((cancelSubscriptionResponse) => {
      return subscriptionCancelled(cancelSubscriptionResponse);
    });
}

function updateSubscription(priceId, subscriptionId) {
  return fetch('/update-subscription', {
    method: 'post',
    headers: {
      'Content-type': 'application/json',
    },
    body: JSON.stringify({
      subscriptionId: subscriptionId,
      newPriceId: priceId,
    }),
  })
    .then((response) => {
      return response.json();
    })
    .then((response) => {
      return response;
    });
}

function retrieveCustomerPaymentMethod(paymentMethodId) {
  return fetch('/retrieve-customer-payment-method', {
    method: 'post',
    headers: {
      'Content-type': 'application/json',
    },
    body: JSON.stringify({
      paymentMethodId: paymentMethodId,
    }),
  })
    .then((response) => {
      return response.json();
    })
    .then((response) => {
      return response;
    });
}

function getConfig() {
  return fetch('/config', {
    method: 'get',
    headers: {
      'Content-Type': 'application/json',
    },
  })
    .then((response) => {
      return response.json();
    })
    .then((response) => {
      // Set up Stripe Elements
      stripeElements(response.publishableKey);
    });
}

getConfig();

/* ------ Sample helpers ------- */

function getFormattedAmount(amount) {
  // Format price details and detect zero decimal currencies
  var amount = amount;
  var numberFormat = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'symbol',
  });
  var parts = numberFormat.formatToParts(amount);
  var zeroDecimalCurrency = true;
  for (var part of parts) {
    if (part.type === 'decimal') {
      zeroDecimalCurrency = false;
    }
  }
  amount = zeroDecimalCurrency ? amount : amount / 100;
  var formattedAmount = numberFormat.format(amount);

  return formattedAmount;
}

function capitalizeFirstLetter(string) {
  let tempString = string.toLowerCase();
  return tempString.charAt(0).toUpperCase() + tempString.slice(1);
}

function getDateStringFromUnixTimestamp(date) {
  let nextPaymentAttemptDate = new Date(date * 1000);
  let day = nextPaymentAttemptDate.getDate();
  let month = nextPaymentAttemptDate.getMonth() + 1;
  let year = nextPaymentAttemptDate.getFullYear();

  return month + '/' + day + '/' + year;
}

// For demo purpose only
function getCustomersPaymentMethod() {
  let params = new URLSearchParams(document.location.search.substring(1));

  let paymentMethodId = params.get('paymentMethodId');
  if (paymentMethodId) {
    retrieveCustomerPaymentMethod(paymentMethodId).then(function (response) {
      document.getElementById('credit-card-last-four').innerText =
        capitalizeFirstLetter(response.card.brand) +
        ' •••• ' +
        response.card.last4;

      document.getElementById(
        'subscribed-price'
      ).innerText = capitalizeFirstLetter(params.get('priceId'));
    });
  }
}

// TODO: why is this here? It should only be relevant on the account page.
getCustomersPaymentMethod();

// Shows the cancellation response
function subscriptionCancelled() {
  document.querySelector('#subscription-cancelled').classList.remove('hidden');
  document.querySelector('#subscription-settings').classList.add('hidden');
}

/* Shows a success / error message when the payment is complete */
function onSubscriptionSampleDemoComplete({
  customerId,
  priceId,
  subscriptionId,
  currentPeriodEnd,
  paymentMethodId,
}) {
  window.location.href =
    '/account.html?subscriptionId=' +
    subscriptionId +
    '&priceId=' +
    priceId +
    '&currentPeriodEnd=' +
    currentPeriodEnd +
    '&customerId=' +
    customerId +
    '&paymentMethodId=' +
    paymentMethodId;
}

function demoChangePrice() {
  document.querySelector('#basic').classList.remove('border-pasha');
  document.querySelector('#premium').classList.remove('border-pasha');
  document.querySelector('#price-change-form').classList.add('hidden');

  // Grab the priceId from the URL
  // This is meant for the demo, replace with a cache or database.
  const params = new URLSearchParams(document.location.search.substring(1));
  const priceId = params.get('priceId').toLowerCase();

  // Show the change price screen
  document.querySelector('#prices-form').classList.remove('hidden');
  document
    .querySelector('#' + priceId.toLowerCase())
    .classList.add('border-pasha');

  let elements = document.querySelectorAll(
    '#submit-' + priceId + '-button-text'
  );
  for (let i = 0; i < elements.length; i++) {
    elements[0].childNodes[3].innerText = 'Current';
  }
  if (priceId === 'premium') {
    document.getElementById('submit-premium').disabled = true;
    document.getElementById('submit-basic').disabled = false;
  } else {
    document.getElementById('submit-premium').disabled = false;
    document.getElementById('submit-basic').disabled = true;
  }
}

// Changes the price selected
function changePriceSelection(priceId) {
  document.querySelector('#basic').classList.remove('border-pasha');
  document.querySelector('#premium').classList.remove('border-pasha');
  document
    .querySelector('#' + priceId.toLowerCase())
    .classList.add('border-pasha');
}

// Show a spinner on subscription submission
function changeLoadingState(isLoading) {
  if (isLoading) {
    document.querySelector('#button-text').classList.add('hidden');
    document.querySelector('#loading').classList.remove('hidden');
    document.querySelector('#signup-form button').disabled = true;
  } else {
    document.querySelector('#button-text').classList.remove('hidden');
    document.querySelector('#loading').classList.add('hidden');
    document.querySelector('#signup-form button').disabled = false;
  }
}

// Show a spinner on subscription submission
function changeLoadingStateAccountPage(isLoading) {
  if (isLoading) {
    document.querySelector('#button-text').classList.add('hidden');
    document.querySelector('#loading').classList.remove('hidden');

    document.querySelector('#submit-basic').classList.add('invisible');
    document.querySelector('#submit-premium').classList.add('invisible');
    if (document.getElementById('confirm-price-change-cancel')) {
      document
        .getElementById('confirm-price-change-cancel')
        .classList.add('invisible');
    }
  } else {
    document.querySelector('#button-text').classList.remove('hidden');
    document.querySelector('#loading').classList.add('hidden');

    document.querySelector('#submit-basic').classList.remove('invisible');
    document.querySelector('#submit-premium').classList.remove('invisible');
    if (document.getElementById('confirm-price-change-cancel')) {
      document
        .getElementById('confirm-price-change-cancel')
        .classList.remove('invisible');
      document
        .getElementById('confirm-price-change-submit')
        .classList.remove('invisible');
    }
  }
}

function changeLoadingStatePrices(isLoading) {
  if (isLoading) {
    document.querySelector('#payment-view .button-text').classList.add('hidden');
    document.querySelector('#payment-view .loading-text').classList.remove('hidden');
  } else {
    document.querySelector('#payment-view .button-text').classList.remove('hidden');
    document.querySelector('#payment-view .loading-text').classList.add('hidden');
  }
}
function getPriceId() {
  return localStorage.getItem('priceId');
}

function setPriceId(priceId) {
  localStorage.setItem('priceId', priceId);
}

function clearCache() {
  localStorage.clear();
}

function resetDemo() {
  clearCache();
  window.location.href = '/';
}
