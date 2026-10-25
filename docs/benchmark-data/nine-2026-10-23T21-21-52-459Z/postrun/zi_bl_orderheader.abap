@EndUserText.label: 'Lab order headers'
@AccessControl.authorizationCheck: #NOT_REQUIRED
define view entity ZI_BL_OrderHeader as select from zbl_ord_hdr as H
  association [0..*] to ZI_BL_OrderPosition as _Positions
    on $projection.OrderId = _Positions.OrderId
{
  key H.order_id as OrderId,
  H.customer_id as CustomerId,
  H.order_date as OrderDate,
  H.status as Status,
  H.currency as Currency,
  @Semantics.amount.currencyCode: 'Currency'
  H.net_amount as NetAmount,
  H.created_at as CreatedAt,
  H.last_changed_at as LastChangedAt,
  _Positions
}
