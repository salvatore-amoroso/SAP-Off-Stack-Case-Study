@EndUserText.label: 'Lab order positions'
@AccessControl.authorizationCheck: #NOT_REQUIRED
define view entity ZI_BL_OrderPosition as select from zbl_ord_pos as P
  association [1..1] to ZI_BL_OrderHeader as _Header
    on $projection.OrderId = _Header.OrderId
{
  key P.order_id as OrderId,
  key cast( P.position_number as abap.char(6) ) as PositionNumber,
  _Header.CustomerId as CustomerId,
  _Header.OrderDate as OrderDate,
  P.material_id as MaterialId,
  @Semantics.quantity.unitOfMeasure: 'Unit'
  P.quantity as Quantity,
  P.unit as Unit,
  @Semantics.amount.currencyCode: 'Currency'
  P.net_amount as NetAmount,
  P.currency as Currency,
  P.last_changed_at as LastChangedAt,
  _Header
}
