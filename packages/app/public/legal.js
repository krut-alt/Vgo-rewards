// Program terms and privacy policy. The wording is fixed; the program facts (who runs it, how
// points are earned and used, when they expire) come from the live program settings.

const STATE_NAMES = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia', TN: 'Tennessee', VA: 'Virginia', FL: 'Florida', AL: 'Alabama' };
const list = (items) => (items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const longDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function contactLines(p) {
  return [p.company, p.address, p.email && `Email: ${p.email}`, p.phone && `Phone: ${p.phone}`].filter(Boolean);
}

/** Sections as [heading, ...paragraphs]; a paragraph that is an array is a bullet list. */
export function termsSections(p) {
  const name = p.programName || 'VGO Rewards';
  const expiry = p.pointsExpireMonths
    ? `Points expire if your account has no qualifying purchase for ${p.pointsExpireMonths} months in a row. Any purchase that earns points resets the clock.`
    : 'Points do not expire while the program is running.';
  return [
    [
      'About the program',
      `${name} (the "Program") is a free loyalty program run by ${p.company} ("we", "us"). It is offered only at participating VGO locations in ${list(p.states.map((st) => STATE_NAMES[st] ?? st))}. By joining or using the Program you agree to these terms.`,
    ],
    [
      'Participating locations only',
      'Points, rewards, and offers are valid ONLY at participating locations where the Program is live. Not every VGO-branded store, and not every store we supply, participates, and no store is required to participate.',
      p.liveStores.length
        ? `The participating locations today are: ${list(p.liveStores)}. The app shows each location as "Rewards live" or "coming soon". A location shown as coming soon does not participate yet, and you cannot earn or use points or rewards there.`
        : 'The app shows each location as "Rewards live" or "coming soon". A location shown as coming soon does not participate yet, and you cannot earn or use points or rewards there.',
      'We may add or remove participating locations, or pause the Program at a location, at any time and without notice. When a location stops participating, points and rewards cannot be earned or used there, but points already in your account stay in your account for use at other participating locations.',
      'Purchases at a location that is not participating, or while the Program is paused there, do not earn points and cannot be credited later. A store employee cannot override this.',
      'Each offer also lists the participating locations where it can be used; an offer is valid only at those locations, even if the Program is live at others.',
    ],
    [
      'Who can join',
      `You must be at least ${p.minAge} years old and a resident of the United States to join. You need a U.S. mobile number, which becomes your member ID. Each person may have one account, and each phone number may be used for only one account.`,
      'You give us your date of birth when you join. You can set it once; to correct it, ask a store employee, who may ask to see a photo ID. Giving a false date of birth may lead us to close your account.',
    ],
    [
      'Earning points',
      p.earn.length ? ['Right now you earn:', ...p.earn.map((e) => `${e}.`)] : 'The app shows how you earn points.',
      'Points are added after a qualifying purchase is completed and paid for. You must enter your phone number or scan your app barcode at the time of purchase; we cannot add points for past purchases. Taxes, fees, deposits, and items excluded above do not earn points.',
      'If a purchase is refunded or reversed, we remove the points it earned and may reverse any reward used with it.',
    ],
    [
      'Using points and rewards',
      p.redeem.length ? ['Points rewards available at participating locations include:', ...p.redeem.map((e) => `${e}.`)] : 'The app lists the rewards you can use your points for.',
      `Choose a reward in the app before your visit, or add an offer to your card, then enter your phone number or scan your barcode at the pump or register. ${p.oneFuelDiscount ? 'Only one fuel discount applies per fill-up; if more than one is available, you get the largest. ' : ''}Fuel discounts apply only up to the number of gallons stated on the reward.`,
      'Points and rewards have no cash value, cannot be sold, transferred, or combined between accounts, and cannot be exchanged for cash or credit. Unused value on a reward is lost. Unless an offer says otherwise and the law allows it, rewards cannot be used toward tobacco, alcohol, lottery, or gift cards, or toward anything else the law or the store does not allow.',
      expiry,
    ],
    [
      'Offers and special rewards',
      'Offers have their own dates, limits, and participating locations, which are shown in the app. Some offers are run and paid for by a single store or by a manufacturer and apply only at the locations stated. We may limit how often an offer can be used.',
      'Birthday rewards are available once per year during the window shown in the app, and only if your date of birth is on your account.',
      'Some offers are only for members 21 and older and are shown only to them. These offers still require a valid photo ID at the register, and the store may refuse any age-restricted sale.',
    ],
    [
      'Text messages and email',
      `If you agree to texts, ${name} will send recurring marketing text messages, such as offers and reward reminders, to the mobile number you provide. Message frequency varies. Message and data rates may apply. Reply STOP to cancel or HELP for help. Agreeing to marketing texts is not a condition of any purchase.`,
      'We also send one-time sign-in codes by text when you sign in. If you add an email address and agree to offer emails, you can unsubscribe at any time from the email or the Account screen.',
    ],
    [
      'Changes, suspension and ending the Program',
      'We may change these terms, the ways to earn and use points, and the rewards offered, or end the Program, at any time. When we make a material change we will post the updated terms in the app and update the date at the top. If we end the Program we will give at least 30 days’ notice in the app, and points not used by the end date will be cancelled.',
      'We may suspend or close an account, and cancel its points and rewards, if we believe it was used for fraud or misuse, or in breach of these terms.',
    ],
    [
      'Limits on our responsibility',
      'The Program is provided "as is". We are not responsible for a location not participating, or stopping participation, in the Program. We are not responsible for points or rewards that are not credited because of a POS, network, or app outage, but we will try to correct a missed credit if you contact us within 30 days with your receipt. To the extent allowed by law, our total responsibility to you for anything related to the Program is limited to the value of the rewards in your account.',
      `These terms are governed by the laws of the State of ${STATE_NAMES[p.governingState] ?? p.governingState}, without regard to its conflict-of-law rules. The Program is void where prohibited.`,
    ],
    ['Contact', contactLines(p).length > 1 ? contactLines(p) : `Questions about the Program? Ask at any participating VGO store.`],
  ];
}

export function privacySections(p) {
  const name = p.programName || 'VGO Rewards';
  return [
    [
      'Who we are',
      `This policy explains how ${p.company} ("we", "us") collects and uses information in ${name}, including the app and our participating stores.`,
    ],
    [
      'What we collect',
      [
        'Account details you give us: mobile number, first name, date of birth, home store, and, if you choose, email address and ZIP code.',
        'Purchase details from participating stores when you use your member ID: the store, date and time, items, gallons, amounts, and the points and rewards used.',
        'App activity: offers you add to your card, rewards you pick, and your text and email choices, with the date you agreed to them.',
        'Location, only when you allow it in the app, to show deals near a store. We use it at that moment and do not store your location history.',
        'A sign-in token saved on your device so you stay signed in.',
      ],
    ],
    [
      'How we use it',
      [
        'To run your account, credit points, and apply rewards at the pump and register.',
        'To show offers that fit you, including age-restricted offers only to members old enough for them.',
        'To send sign-in codes and, if you agreed, offers by text or email.',
        'To understand how the Program is doing at each store, and to prevent fraud and misuse.',
        'To comply with the law.',
      ],
    ],
    [
      'Who we share it with',
      [
        'Participating stores, which see visits, points, and rewards for members who shop with them, to run the Program at that store.',
        'Service providers that help us run the Program, such as hosting and database providers, text and email services, and the company that connects our stores’ registers and pumps to the Program. They may use the information only to provide those services.',
        'Manufacturers that fund an offer, which receive totals of how often it was used, not your personal details.',
        'Authorities, when the law requires it, or to protect the rights and safety of our members, stores, and others.',
      ],
      'We do not sell your personal information, and we do not share your mobile number or text-message consent with anyone for their own marketing.',
    ],
    [
      'Your choices',
      [
        'Turn offer texts or emails off at any time on the Account screen, by replying STOP to a text, or by using the unsubscribe link in an email.',
        'Update your name, email, ZIP, and home store on the Account screen.',
        'Ask us for a copy of your information, to correct it, or to delete your account by contacting us below. Deleting your account cancels your points and rewards.',
      ],
    ],
    ['Keeping it safe and how long we keep it', 'We protect your information with reasonable safeguards, including encrypted connections and hashed sign-in codes. We keep account information while your account is open and purchase records as long as needed to run the Program and meet legal and accounting needs.'],
    ['Children', `The Program is only for people ${p.minAge} and older. We do not knowingly collect information from anyone younger. If we learn that we have, we will delete it.`],
    ['Changes to this policy', 'If we change this policy we will post the new version in the app and update the date at the top. If a change materially affects how we use information we already have, we will tell you in the app first.'],
    ['Contact', contactLines(p).length > 1 ? contactLines(p) : 'Questions about your privacy? Ask at any participating VGO store.'],
  ];
}

export function legalPage(h, kind, p, back) {
  const sections = kind === 'privacy' ? privacySections(p) : termsSections(p);
  const title = kind === 'privacy' ? 'Privacy policy' : 'Program terms';
  return h(
    'div',
    { class: 'screen legal' },
    h('header', { class: 'page-title' }, h('button', { class: 'switch-mode', style: 'align-self:flex-start', onclick: back }, '← Back'), h('h1', {}, title), h('span', {}, `${p.programName || 'VGO Rewards'} · Updated ${longDate(p.updated)}`)),
    h(
      'main',
      { class: 'content' },
      sections.map(([heading, ...paras]) =>
        h(
          'section',
          {},
          h('h2', {}, heading),
          paras.map((para) => (Array.isArray(para) ? (para.length && /:$/.test(para[0]) ? [h('p', {}, para[0]), h('ul', {}, para.slice(1).map((li) => h('li', {}, li)))] : h('ul', {}, para.map((li) => h('li', {}, li)))) : h('p', {}, para))),
        ),
      ),
      h('p', { class: 'fine' }, h('a', { href: kind === 'privacy' ? '#/terms' : '#/privacy' }, kind === 'privacy' ? 'Program terms' : 'Privacy policy')),
    ),
  );
}
