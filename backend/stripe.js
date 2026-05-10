import Stripe from 'stripe';
import admin from 'firebase-admin';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  starter: { name: 'MemeScanner Starter', monthly: 2900, yearly: 27840 },
  pro:     { name: 'MemeScanner Pro',     monthly: 5900, yearly: 56640 },
  elite:   { name: 'MemeScanner Elite',   monthly: 9900, yearly: 94800 },
};

export async function createCheckoutSession({ email, password, plan, period }) {
  const planConfig = PLANS[plan] || PLANS.pro;
  const amount   = period === 'yearly' ? planConfig.yearly  : planConfig.monthly;
  const interval = period === 'yearly' ? 'year' : 'month';

  // Créer ou récupérer le compte Firebase Auth
  let uid;
  try {
    const existing = await admin.auth().getUserByEmail(email);
    uid = existing.uid;
    await admin.auth().updateUser(uid, { password });
  } catch {
    const user = await admin.auth().createUser({ email, password });
    uid = user.uid;
  }

  // Stocker en pending dans Firebase DB
  await admin.database().ref(`users/${uid}`).set({
    email, plan, period, status: 'pending', createdAt: Date.now(),
  });

  // Créer la session Stripe Checkout
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    customer_email: email,
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: planConfig.name },
        unit_amount: amount,
        recurring: { interval },
      },
      quantity: 1,
    }],
    metadata: { uid, email, plan, period },
    success_url: `${process.env.SITE_URL || 'http://localhost:3000'}/?payment=success`,
    cancel_url:  `${process.env.SITE_URL || 'http://localhost:3000'}/?payment=cancel`,
    locale: 'fr',
  });

  return { url: session.url, sessionId: session.id };
}

export async function handleStripeWebhook(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET manquant');

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    throw new Error(`Signature webhook invalide: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { uid, email, plan, period } = session.metadata || {};
    if (!uid) return { received: true };

    await admin.auth().updateUser(uid, { disabled: false });
    await admin.database().ref(`users/${uid}`).update({
      status: 'active', plan, period,
      stripeCustomerId: session.customer,
      stripeSessionId: session.id,
      activatedAt: Date.now(),
    });
    console.log(`[Stripe] ✅ ${email} (${plan})`);
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const snap = await admin.database().ref('users')
      .orderByChild('stripeCustomerId').equalTo(sub.customer).once('value');
    const users = snap.val();
    if (users) {
      for (const uid of Object.keys(users)) {
        await admin.database().ref(`users/${uid}`).update({ status: 'cancelled', cancelledAt: Date.now() });
      }
    }
  }

  return { received: true };
}

export async function getUserSubscription(uid) {
  const snap = await admin.database().ref(`users/${uid}`).once('value');
  return snap.val();
}
