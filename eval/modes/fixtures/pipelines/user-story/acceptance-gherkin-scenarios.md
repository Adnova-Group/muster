Scenario: Happy path — valid coupon applies the discount
Given a cart with a $100 subtotal
When the shopper applies coupon "SAVE10"
Then the order total shows $90

Scenario: Edge — expired coupon is rejected
Given a cart with a $100 subtotal
When the shopper applies an expired coupon
Then the order shows an "expired coupon" error and the total stays $100

Scenario: Negative — coupon on an empty cart
Given an empty cart
When the shopper applies coupon "SAVE10"
Then the order shows a "cart is empty" error
